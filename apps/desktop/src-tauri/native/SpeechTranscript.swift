import Foundation

/// Apple emits zero-time provisional hypotheses between timed phrases.
/// Keep confirmed phrases separate from the currently revisable hypothesis.
struct SpeechTranscript {
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
            // New phrase: Apple has returned to its provisional zero clock.
            commit()
        } else if timed && !provisional, let last = current.last,
                  first.start >= last.end - 0.001 && first.start > (current.first?.start ?? 0) {
            commit()
        }
        let full = render(confirmed)
        if !full.isEmpty && candidate.count > full.count && candidate.hasPrefix(full) {
            // A final cumulative callback may cover all previously confirmed phrases.
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
