import Foundation
import Speech
import AVFoundation

// The browser owns the microphone. All native state lives on this serial queue.
private let speechQueue = DispatchQueue(label: "com.leadingthink.miniq.speech")
private typealias Callback = @convention(c) (UnsafePointer<CChar>) -> Void
@available(macOS 10.15, *)
private var active: Recognition?

@available(macOS 10.15, *)
private final class Recognition {
    let id: String
    let callback: Callback
    let format: AVAudioFormat
    let recognizer: SFSpeechRecognizer
    let request = SFSpeechAudioBufferRecognitionRequest()
    var task: SFSpeechRecognitionTask?
    var ending = false
    var transcript = SpeechTranscript()

    init?(id: String, locale: String, rate: Double, callback: @escaping Callback) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
              recognizer.isAvailable, recognizer.supportsOnDeviceRecognition,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate,
                                         channels: 1, interleaved: false) else { return nil }
        self.id = id; self.callback = callback; self.format = format; self.recognizer = recognizer
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
    }

    func send(_ kind: String, text: String = "") {
        guard let data = try? JSONSerialization.data(withJSONObject: ["id": id, "kind": kind, "text": text]),
              let json = String(data: data, encoding: .utf8) else { return }
        json.withCString { callback($0) }
    }

    func start() {
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            speechQueue.async { [weak self] in
                guard let self = self, active === self else { return }
                if let result = result {
                    let text = self.transcript.update(result.bestTranscription.segments.map {
                        SpeechTranscript.Segment(text: $0.substring, start: $0.timestamp, end: $0.timestamp + $0.duration)
                    })
                    // A spontaneous final may be the recognizer's time limit. Fall back with
                    // all captured audio instead of silently losing the remainder of dictation.
                    if result.isFinal {
                        self.send(self.ending ? "final" : "error", text: self.ending ? text : "local-ended-early")
                        self.stop()
                        return
                    }
                    self.send("partial", text: text)
                }
                if error != nil { self.send("error", text: "local-recognition-failed"); self.stop() }
            }
        }
        send("ready")
    }

    func stop() {
        if active === self { active = nil }
        task?.cancel(); task = nil
        request.endAudio()
    }
}

@_cdecl("miniq_apple_speech_available")
public func available(_ language: UnsafePointer<CChar>) -> Int32 {
    guard #available(macOS 10.15, *) else { return 0 }
    let locale = String(cString: language)
    let status = SFSpeechRecognizer.authorizationStatus()
    guard status != .denied && status != .restricted,
          let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else { return 0 }
    return recognizer.isAvailable && recognizer.supportsOnDeviceRecognition ? 1 : 0
}

@_cdecl("miniq_apple_speech_start")
public func start(_ identity: UnsafePointer<CChar>, _ language: UnsafePointer<CChar>, _ rate: Double,
                  _ callback: @escaping @convention(c) (UnsafePointer<CChar>) -> Void) {
    guard #available(macOS 10.15, *) else { return }
    let id = String(cString: identity), locale = String(cString: language)
    speechQueue.async {
        if let previous = active { previous.send("error", text: "local-session-replaced"); previous.stop() }
        guard let recognition = Recognition(id: id, locale: locale, rate: rate, callback: callback) else {
            let data = try! JSONSerialization.data(withJSONObject: ["id": id, "kind": "error", "text": "local-unavailable"])
            String(data: data, encoding: .utf8)!.withCString { callback($0) }
            return
        }
        active = recognition
        // A WebView reload may lose its JS cancellation callback.
        speechQueue.asyncAfter(deadline: .now() + 205) { [weak recognition] in
            guard let recognition = recognition, active === recognition else { return }
            recognition.send("error", text: "local-session-timeout"); recognition.stop()
        }
        // Only called after a microphone click, never by capability discovery.
        SFSpeechRecognizer.requestAuthorization { status in
            speechQueue.async {
                guard active === recognition else { return }
                if status == .authorized { recognition.start() }
                else { recognition.send("error", text: "local-permission-unavailable"); recognition.stop() }
            }
        }
    }
}

@_cdecl("miniq_apple_speech_append")
public func append(_ identity: UnsafePointer<CChar>, _ samples: UnsafePointer<Float>, _ count: Int32) {
    guard #available(macOS 10.15, *) else { return }
    let id = String(cString: identity)
    let copied = Array(UnsafeBufferPointer(start: samples, count: Int(count)))
    speechQueue.async {
        guard let recognition = active, recognition.id == id, !recognition.ending,
              let buffer = AVAudioPCMBuffer(pcmFormat: recognition.format, frameCapacity: AVAudioFrameCount(count)),
              let channel = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(count)
        copied.withUnsafeBufferPointer { source in channel.update(from: source.baseAddress!, count: copied.count) }
        recognition.request.append(buffer)
    }
}

@_cdecl("miniq_apple_speech_finish")
public func finish(_ identity: UnsafePointer<CChar>) {
    guard #available(macOS 10.15, *) else { return }
    let id = String(cString: identity)
    speechQueue.async {
        guard let recognition = active, recognition.id == id else { return }
        recognition.ending = true
        recognition.request.endAudio()
        speechQueue.asyncAfter(deadline: .now() + 8) { [weak recognition] in
            guard let recognition = recognition, active === recognition else { return }
            recognition.send("error", text: "local-finish-timeout"); recognition.stop()
        }
    }
}

@_cdecl("miniq_apple_speech_cancel")
public func cancel(_ identity: UnsafePointer<CChar>) {
    guard #available(macOS 10.15, *) else { return }
    let id = String(cString: identity)
    speechQueue.async { if let recognition = active, recognition.id == id { recognition.stop() } }
}
