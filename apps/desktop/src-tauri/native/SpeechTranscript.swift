import Foundation

/// Apple can return only the latest phrase after a pause. Keep earlier timed
/// segments and replace only the range revised by the latest recognition result.
struct SpeechTranscript {
    struct Segment {
        let text: String
        let start: TimeInterval
        let end: TimeInterval
    }
    private var segments: [Segment] = []
    mutating func update(_ incoming: [Segment]) -> String {
        guard let first = incoming.first else { return text }
        // Preserve words strictly before the incoming range. The same-range
        // hypotheses replace previous words, so corrections are not appended twice.
        let prefix = segments.prefix { $0.end <= first.start + 0.001 && $0.start < first.start - 0.001 }
        segments = Array(prefix) + incoming
        return text
    }
    var text: String {
        segments.reduce("") { output, segment in
            guard !segment.text.isEmpty else { return output }
            let latin = segment.text.unicodeScalars.first.map { $0.isASCII && CharacterSet.alphanumerics.contains($0) } ?? false
            return output + (output.isEmpty || !latin ? "" : " ") + segment.text
        }
    }
}
