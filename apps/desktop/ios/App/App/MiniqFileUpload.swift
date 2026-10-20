import Foundation

/// PUT reads the app-owned cache file directly; response bodies are discarded, never accumulated.
final class MiniqFileUpload: NSObject, URLSessionDataDelegate {
    let id: String
    private let file: MiniqCachedUpload
    private let progress: (Int64) -> Void
    private let completion: (Result<String, Error>) -> Void
    private let cancellation = MiniqUploadCancellation()
    private var session: URLSession?
    private var responseStatus: Int?
    private var lastProgress: TimeInterval = 0
    var cancelled: Bool { cancellation.isCancelled }

    init(id: String, file: MiniqCachedUpload, progress: @escaping (Int64) -> Void,
         completion: @escaping (Result<String, Error>) -> Void) {
        self.id = id
        self.file = file
        self.progress = progress
        self.completion = completion
    }

    func start(url: URL) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 900
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        self.session = session
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "PUT"
        request.httpShouldHandleCookies = false
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(file.size), forHTTPHeaderField: "Content-Length")
        let task = session.uploadTask(with: request, fromFile: file.url)
        cancellation.onCancel { task.cancel() }
        task.resume()
    }

    func cancel() { cancellation.cancel() }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        responseStatus = response.statusCode
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authenticate(challenge, response: challenge.failureResponse, completion: completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authenticate(challenge, response: challenge.failureResponse ?? task.response, completion: completionHandler)
    }

    private func authenticate(_ challenge: URLAuthenticationChallenge, response: URLResponse?,
                              completion: (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // Normal system TLS validation is required; stored/password/client credentials are forbidden.
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completion(.performDefaultHandling, nil)
        } else {
            if let response = response as? HTTPURLResponse { responseStatus = response.statusCode }
            completion(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        responseStatus = (response as? HTTPURLResponse)?.statusCode
        completionHandler(responseStatus.map { (200...299).contains($0) } == true ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) { }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, willCacheResponse proposedResponse: CachedURLResponse,
                    completionHandler: @escaping (CachedURLResponse?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard !cancellation.isCancelled else { return }
        let now = Date.timeIntervalSinceReferenceDate
        if now - lastProgress >= 0.1 || totalBytesSent >= file.size {
            lastProgress = now
            progress(min(file.size, max(0, totalBytesSent)))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        session.finishTasksAndInvalidate()
        self.session = nil
        cancellation.clearHandlers()
        if cancellation.isCancelled { completion(.success("cancelled")); return }
        if let status = responseStatus, !(200...299).contains(status) {
            completion(.failure(NSError(domain: "MiniqUpload", code: status,
                userInfo: [NSLocalizedDescriptionKey: "文件上传失败 (\(status))"])))
        } else if error != nil || responseStatus == nil {
            // URLSession errors can contain the signed URL; never forward their diagnostics to JS.
            completion(.failure(NSError(domain: "MiniqUpload", code: 0,
                userInfo: [NSLocalizedDescriptionKey: "文件上传失败，请重试"])))
        } else {
            progress(file.size)
            completion(.success("uploaded"))
        }
    }
}
