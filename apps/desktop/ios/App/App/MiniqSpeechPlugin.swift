import AVFoundation
import Capacitor
import Foundation
import Speech

private let speechQueue = DispatchQueue(label: "com.leadingthink.miniq.ios.speech")

/// Keeps confirmed phrases separate when Apple resets provisional segment timestamps.
private struct SpeechTranscript {
    struct Segment {
        let text: String
        let start: TimeInterval
        let end: TimeInterval
    }
    private var confirmed: [Segment] = []
    private var current: [Segment] = []
    private var timed = false

    mutating func update(_ incoming: [Segment]) -> String {
        guard let first = incoming.first else { return text }
        let candidate = render(incoming)
        let provisional = incoming.allSatisfy { $0.start == 0 && $0.end == 0 }
        let previous = render(current)
        if timed && provisional && !candidate.hasPrefix(previous) && candidate != previous {
            commit()
        } else if timed && !provisional, let last = current.last,
                  first.start >= last.end - 0.001 && first.start > (current.first?.start ?? 0) {
            commit()
        }
        let full = render(confirmed)
        if !full.isEmpty && candidate.count > full.count && candidate.hasPrefix(full) {
            confirmed = []
        }
        current = incoming
        timed = !provisional
        return text
    }

    mutating func commit() {
        confirmed.append(contentsOf: current)
        current = []
        timed = false
    }

    var text: String { render(confirmed + current) }
    private func render(_ values: [Segment]) -> String {
        values.reduce("") { output, segment in
            guard !segment.text.isEmpty else { return output }
            let latin = segment.text.unicodeScalars.first.map { $0.isASCII && CharacterSet.alphanumerics.contains($0) } ?? false
            return output + (output.isEmpty || !latin ? "" : " ") + segment.text
        }
    }
}

private final class RecognitionSession {
    let id: String
    let format: AVAudioFormat
    let recognizer: SFSpeechRecognizer
    let notify: ([String: Any]) -> Void
    var request = RecognitionSession.makeRequest()
    var task: SFSpeechRecognitionTask?
    var generation = 0
    var ending = false
    var stopped = false
    var transcript = SpeechTranscript()

    init?(id: String, locale: String, rate: Double, notify: @escaping ([String: Any]) -> Void) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
              recognizer.isAvailable, recognizer.supportsOnDeviceRecognition,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate,
                                         channels: 1, interleaved: false) else { return nil }
        self.id = id
        self.format = format
        self.recognizer = recognizer
        self.notify = notify
    }

    static func makeRequest() -> SFSpeechAudioBufferRecognitionRequest {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if #available(iOS 16.0, *) { request.addsPunctuation = true }
        return request
    }

    func send(_ kind: String, text: String = "") {
        guard !stopped else { return }
        notify(["id": id, "kind": kind, "text": text])
    }

    func start(onStop: @escaping (RecognitionSession) -> Void) {
        generation += 1
        let generation = generation
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            speechQueue.async { [weak self] in
                guard let self = self, !self.stopped, self.generation == generation else { return }
                if let result = result {
                    let text = self.transcript.update(result.bestTranscription.segments.map {
                        SpeechTranscript.Segment(text: $0.substring, start: $0.timestamp, end: $0.timestamp + $0.duration)
                    })
                    if result.isFinal {
                        if self.ending {
                            self.send("final", text: text)
                            onStop(self)
                        } else {
                            self.transcript.commit()
                            self.send("partial", text: text)
                            self.request = RecognitionSession.makeRequest()
                            self.start(onStop: onStop)
                        }
                        return
                    }
                    self.send("partial", text: text)
                }
                if error != nil {
                    self.send("error", text: "local-recognition-failed")
                    onStop(self)
                }
            }
        }
        send("ready")
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        task?.cancel()
        task = nil
        request.endAudio()
    }
}

@objc(MiniqSpeechPlugin)
public class MiniqSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MiniqSpeechPlugin"
    public let jsName = "MiniqSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "append", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private var active: RecognitionSession?

    @objc func available(_ call: CAPPluginCall) {
        let locale = call.getString("language") ?? "zh-CN"
        let status = SFSpeechRecognizer.authorizationStatus()
        guard status != .denied && status != .restricted,
              let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
            call.resolve(["available": false])
            return
        }
        call.resolve(["available": recognizer.isAvailable && recognizer.supportsOnDeviceRecognition])
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty, id.count <= 128 else {
            call.reject("invalid speech identifier")
            return
        }
        let locale = call.getString("language") ?? "zh-CN"
        let rate = call.getDouble("sampleRate") ?? 0
        guard rate.isFinite, (8000.0...192000.0).contains(rate) else {
            call.reject("invalid speech sample rate")
            return
        }
        speechQueue.async { [weak self] in
            guard let self = self else { return }
            if let previous = self.active {
                previous.send("error", text: "local-session-replaced")
                previous.stop()
                self.active = nil
            }
            guard let session = RecognitionSession(
                id: id,
                locale: locale,
                rate: rate,
                notify: { [weak self] data in self?.notifyListeners("speechEvent", data: data) }
            ) else {
                self.notifyListeners("speechEvent", data: ["id": id, "kind": "error", "text": "local-unavailable"])
                call.resolve()
                return
            }
            self.active = session
            speechQueue.asyncAfter(deadline: .now() + 205) { [weak self, weak session] in
                guard let self = self, let session = session, self.active === session else { return }
                session.send("error", text: "local-session-timeout")
                self.stopSession(session)
            }
            SFSpeechRecognizer.requestAuthorization { [weak self, weak session] status in
                speechQueue.async {
                    guard let self = self, let session = session, self.active === session else { return }
                    if status == .authorized {
                        session.start { [weak self] current in self?.stopSession(current) }
                    } else {
                        session.send("error", text: "local-permission-unavailable")
                        self.stopSession(session)
                    }
                }
            }
            call.resolve()
        }
    }

    @objc func append(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("invalid speech identifier")
            return
        }
        guard let rawSamples = call.getArray("samples"), !rawSamples.isEmpty, rawSamples.count <= 32768 else {
            call.reject("invalid speech audio chunk")
            return
        }
        var copied = [Float]()
        copied.reserveCapacity(rawSamples.count)
        for item in rawSamples {
            guard let number = item as? NSNumber else {
                call.reject("invalid speech audio sample")
                return
            }
            let value = number.floatValue
            guard value.isFinite else {
                call.reject("invalid speech audio sample")
                return
            }
            copied.append(value)
        }
        speechQueue.async { [weak self] in
            guard let self = self,
                  let session = self.active,
                  session.id == id,
                  !session.ending,
                  let buffer = AVAudioPCMBuffer(pcmFormat: session.format, frameCapacity: AVAudioFrameCount(copied.count)),
                  let channel = buffer.floatChannelData?[0] else {
                call.reject("speech session ended")
                return
            }
            buffer.frameLength = AVAudioFrameCount(copied.count)
            copied.withUnsafeBufferPointer { source in
                if let base = source.baseAddress {
                    channel.update(from: base, count: copied.count)
                }
            }
            session.request.append(buffer)
            call.resolve()
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("invalid speech identifier")
            return
        }
        speechQueue.async { [weak self] in
            guard let self = self, let session = self.active, session.id == id else {
                call.reject("speech session ended")
                return
            }
            session.ending = true
            session.request.endAudio()
            speechQueue.asyncAfter(deadline: .now() + 8) { [weak self, weak session] in
                guard let self = self, let session = session, self.active === session else { return }
                session.send("error", text: "local-finish-timeout")
                self.stopSession(session)
            }
            call.resolve()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        speechQueue.async { [weak self] in
            guard let self = self else { return }
            if let session = self.active, session.id == id {
                self.stopSession(session)
            }
            call.resolve()
        }
    }

    private func stopSession(_ session: RecognitionSession) {
        if active === session {
            active = nil
        }
        session.stop()
    }
}
