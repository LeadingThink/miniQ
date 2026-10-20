import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// One selection is a transaction. Its serial worker owns staged files until the whole selection succeeds.
final class MiniqUploadPicker: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate,
    UIAdaptivePresentationControllerDelegate
{
    let id: String
    private let limit: Int
    private let cache: MiniqUploadCache
    private let completion: (Result<[MiniqCachedUpload], Error>) -> Void
    private let cancellation = MiniqUploadCancellation()
    private let worker = DispatchQueue(label: "com.leadingthink.miniq.upload-picker", qos: .userInitiated)
    private let workerKey = DispatchSpecificKey<Bool>()
    private weak var controller: UIViewController?
    private var selectionReceived = false // Main queue only.
    private var staged: [MiniqCachedUpload] = [] // Worker only.
    private var finished = false // Worker only.

    init(id: String, limit: Int, cache: MiniqUploadCache,
         completion: @escaping (Result<[MiniqCachedUpload], Error>) -> Void) {
        self.id = id
        self.limit = limit
        self.cache = cache
        self.completion = completion
        super.init()
        worker.setSpecific(key: workerKey, value: true)
    }

    func present(kind: String, from presenter: UIViewController) {
        let picker: UIViewController
        if kind == "photos" {
            var configuration = PHPickerConfiguration()
            configuration.selectionLimit = limit
            configuration.selection = .ordered
            configuration.filter = .images
            configuration.preferredAssetRepresentationMode = .current
            let photos = PHPickerViewController(configuration: configuration)
            photos.delegate = self
            picker = photos
        } else {
            let documents = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: false)
            documents.allowsMultipleSelection = limit > 1
            documents.delegate = self
            picker = documents
        }
        controller = picker
        picker.presentationController?.delegate = self
        presenter.present(picker, animated: true)
    }

    func cancel() {
        cancellation.cancel()
        worker.async { self.finish(.failure(MiniqUploadError.cancelled)) }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { cancel() }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { cancel() }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard !selectionReceived else { return }
        selectionReceived = true
        worker.async {
            guard !self.finished else { return }
            guard urls.count <= self.limit else { self.finish(.failure(self.limitError)); return }
            do {
                for url in urls {
                    try self.cancellation.check()
                    self.staged.append(try self.copyDocument(url))
                }
                self.finish(.success(self.staged))
            } catch { self.finish(.failure(error)) }
        }
    }

    private var limitError: NSError {
        NSError(domain: "MiniqUpload", code: 1, userInfo: [NSLocalizedDescriptionKey: "选择的文件不能超过 \(limit) 份"])
    }

    private func copyDocument(_ source: URL) throws -> MiniqCachedUpload {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let coordinator = NSFileCoordinator(filePresenter: nil)
        cancellation.onCancel { coordinator.cancel() }
        var coordinationError: NSError?
        var result: Result<MiniqCachedUpload, Error>?
        coordinator.coordinate(readingItemAt: source, options: [], error: &coordinationError) { coordinated in
            result = Result {
                try self.cache.copy(source: coordinated, name: source.lastPathComponent, cancellation: self.cancellation)
            }
        }
        if coordinationError != nil {
            if case .success(let file)? = result { cache.release([file.id]) }
            try cancellation.check()
            throw MiniqUploadError.unreadable
        }
        if let result { return try result.get() }
        try cancellation.check()
        throw MiniqUploadError.unreadable
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard !selectionReceived else { return }
        selectionReceived = true
        if results.isEmpty { cancel(); return }
        worker.async {
            guard !self.finished else { return }
            guard results.count <= self.limit else { self.finish(.failure(self.limitError)); return }
            self.copyPhoto(results, index: 0)
        }
    }

    private func copyPhoto(_ results: [PHPickerResult], index: Int) {
        guard !finished else { return }
        if cancellation.isCancelled { finish(.failure(MiniqUploadError.cancelled)); return }
        guard index < results.count else { finish(.success(staged)); return }
        let provider = results[index].itemProvider
        guard let type = provider.registeredTypeIdentifiers.first(where: {
            guard let type = UTType($0) else { return false }
            return type.conforms(to: .image)
        }) else { finish(.failure(MiniqUploadError.unreadable)); return }
        let progress = provider.loadFileRepresentation(forTypeIdentifier: type) { [self] url, error in
            // The provider deletes this URL when its callback returns. Copy synchronously here.
            let copy = {
                guard !self.finished else { return }
                do {
                    try self.cancellation.check()
                    guard error == nil, let url else { throw MiniqUploadError.unreadable }
                    var name = provider.suggestedName ?? url.lastPathComponent
                    guard MiniqUploadValidation.filename(name) else { throw MiniqUploadError.invalidName }
                    if (name as NSString).pathExtension.isEmpty, !url.pathExtension.isEmpty {
                        name += "." + url.pathExtension
                    }
                    self.staged.append(try self.cache.copy(source: url, name: name, cancellation: self.cancellation))
                    self.worker.async { self.copyPhoto(results, index: index + 1) }
                } catch { self.finish(.failure(error)) }
            }
            if DispatchQueue.getSpecific(key: workerKey) == true { copy() }
            else { worker.sync(execute: copy) }
        }
        cancellation.onCancel { progress.cancel() }
    }

    private func finish(_ result: Result<[MiniqCachedUpload], Error>) {
        guard !finished else { return }
        finished = true
        cancellation.clearHandlers()
        let result = cancellation.isCancelled ? .success([]) : result
        if case .success(let files) = result, !files.isEmpty {
            staged.removeAll()
        } else {
            cache.release(staged.map(\.id))
            staged.removeAll()
        }
        DispatchQueue.main.async {
            // A cancel may arrive after the worker finishes but before the bridge resolves.
            let deliver = {
                if self.cancellation.isCancelled {
                    if case .success(let files) = result { self.cache.release(files.map(\.id)) }
                    self.completion(.success([]))
                } else {
                    self.completion(result)
                }
            }
            if let controller = self.controller, controller.presentingViewController != nil {
                controller.dismiss(animated: true, completion: deliver)
            } else { deliver() }
        }
    }
}
