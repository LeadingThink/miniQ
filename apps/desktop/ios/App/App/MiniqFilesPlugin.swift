import Capacitor
import CryptoKit
import Foundation
import UIKit

/// Streaming download with a strict byte cap. Signed URLs never enter diagnostics.
private final class FileDownload: NSObject, URLSessionDataDelegate {
    let id: String
    let call: CAPPluginCall
    let expected: Int64
    let expectedHash: String
    let file: URL
    let progress: (Int64) -> Void
    let completion: (Bool, Bool) -> Void
    private var stream: OutputStream?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var digest = SHA256()
    private var received: Int64 = 0
    private var lastProgress: TimeInterval = 0
    private var invalid = false
    private let lock = NSLock()
    private var isCancelled = false
    var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return isCancelled }

    init(id: String, call: CAPPluginCall, expected: Int64, hash: String, file: URL,
         progress: @escaping (Int64) -> Void, completion: @escaping (Bool, Bool) -> Void) {
        self.id = id; self.call = call; self.expected = expected; self.expectedHash = hash
        self.file = file; self.progress = progress; self.completion = completion
    }

    func start(url: URL) {
        stream = OutputStream(url: file, append: false)
        stream?.open()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 900
        config.urlCache = nil
        config.httpCookieStorage = nil
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        var request = URLRequest(url: url)
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        task = session?.dataTask(with: request)
        task?.resume()
    }

    func cancel() {
        lock.lock(); isCancelled = true; lock.unlock()
        task?.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let valid = (response as? HTTPURLResponse)?.statusCode == 200
            && (response.expectedContentLength < 0 || response.expectedContentLength == expected)
        invalid = !valid
        completionHandler(valid && !cancelled ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !cancelled, !invalid, Int64(data.count) <= expected - received, let stream else {
            invalid = true; dataTask.cancel(); return
        }
        let written = data.withUnsafeBytes { raw -> Bool in
            guard let pointer = raw.bindMemory(to: UInt8.self).baseAddress else { return data.isEmpty }
            var offset = 0
            while offset < data.count {
                let count = stream.write(pointer.advanced(by: offset), maxLength: data.count - offset)
                if count <= 0 { return false }
                offset += count
            }
            return true
        }
        guard written else { invalid = true; dataTask.cancel(); return }
        digest.update(data: data)
        received += Int64(data.count)
        let now = Date.timeIntervalSinceReferenceDate
        if now - lastProgress >= 0.1 || received == expected { lastProgress = now; progress(received) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        stream?.close(); stream = nil
        let actual = digest.finalize().map { String(format: "%02x", $0) }.joined()
        let ok = error == nil && !invalid && !cancelled && received == expected && actual == expectedHash
        session.finishTasksAndInvalidate()
        self.session = nil; self.task = nil
        completion(ok, cancelled)
    }
}

@objc(MiniqFilesPlugin)
public class MiniqFilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MiniqFilesPlugin"
    public let jsName = "MiniqFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]
    private var active: FileDownload?
    private var sheet: UIActivityViewController?

    @objc func save(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.begin(call) }
    }

    private func begin(_ call: CAPPluginCall) {
        guard active == nil else { call.reject("已有文件正在保存"); return }
        guard let id = call.getString("id"), id.range(of: "^[A-Za-z0-9-]{8,80}$", options: .regularExpression) != nil,
              let name = call.getString("filename"), !name.isEmpty, name.count <= 240,
              !name.contains("/"), !name.contains("\\"), name != ".", name != "..",
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let size = call.getInt("size"), size >= 0, size <= 200 * 1024 * 1024,
              let hash = call.getString("sha256"), hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let raw = call.getString("url"), let url = URL(string: raw), url.scheme == "https",
              url.host?.hasSuffix(".qiniucs.com") == true, url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, url.fragment == nil, url.path.contains("/remote-files/")
        else { call.reject("文件下载信息无效"); return }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remote-files", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            // Only one transfer is allowed; clear files left by a previous terminated app.
            for stale in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
                try FileManager.default.removeItem(at: stale)
            }
            let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent(name)
            let download = FileDownload(id: id, call: call, expected: Int64(size), hash: hash, file: file,
                progress: { [weak self] received in
                    self?.notifyListeners("progress", data: ["id": id, "received": received, "total": size])
                }, completion: { [weak self] ok, cancelled in
                    DispatchQueue.main.async {
                        guard let self, let active = self.active, active.id == id else { return }
                        if cancelled || active.cancelled { self.finish(id: id, status: "cancelled"); return }
                        guard ok else { self.finish(id: id, error: "文件下载失败或完整性校验失败，请重试"); return }
                        self.share()
                    }
                })
            active = download
            download.start(url: url)
        } catch { call.reject("无法创建文件保存缓存"); }
    }

    private func share() {
        guard let active else { return }
        if active.cancelled { finish(id: active.id, status: "cancelled"); return }
        guard let controller = bridge?.viewController,
              controller.presentedViewController == nil else {
            finish(id: active.id, error: "无法打开系统文件分享窗口"); return
        }
        let activity = UIActivityViewController(activityItems: [active.file], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = controller.view
            popover.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        activity.completionWithItemsHandler = { [weak self] _, completed, _, error in
            DispatchQueue.main.async {
                if active.cancelled { self?.finish(id: active.id, status: "cancelled") }
                else if error != nil { self?.finish(id: active.id, error: "文件未能保存或分享，请重试") }
                else { self?.finish(id: active.id, status: completed ? "shared" : "cancelled") }
            }
        }
        sheet = activity
        controller.present(activity, animated: true)
    }

    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let active = self.active, active.id == call.getString("id") {
                active.cancel()
                if let sheet = self.sheet {
                    sheet.dismiss(animated: true) { self.finish(id: active.id, status: "cancelled") }
                }
            }
            call.resolve()
        }
    }

    private func finish(id: String, status: String? = nil, error: String? = nil) {
        guard let active, active.id == id else { return }
        self.active = nil; sheet = nil
        try? FileManager.default.removeItem(at: active.file.deletingLastPathComponent())
        if let status { active.call.resolve(["status": status]) }
        else { active.call.reject(error ?? "文件保存失败") }
    }
}
