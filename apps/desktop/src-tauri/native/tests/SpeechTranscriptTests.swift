import Foundation
@main struct Tests {
    static func main() {
        typealias S = SpeechTranscript.Segment
        var transcript = SpeechTranscript()
        assert(transcript.update([S(text: "第一段", start: 0, end: 1)]) == "第一段")
        assert(transcript.update([S(text: "第二", start: 3, end: 4)]) == "第一段第二")
        assert(transcript.update([S(text: "第二段", start: 3, end: 4.5)]) == "第一段第二段")
        // A final callback containing only the latest phrase must keep all earlier text.
        assert(transcript.update([S(text: "最后一段", start: 7, end: 8)]) == "第一段第二段最后一段")
        assert(transcript.update([S(text: "最后一段。", start: 7, end: 8)]) == "第一段第二段最后一段。")
        assert(transcript.update([]) == "第一段第二段最后一段。")
        // A complete revised hypothesis must replace its own range, without duplicates.
        assert(transcript.update([S(text: "第一段修正", start: 0, end: 1), S(text: "第二段", start: 3, end: 4.5), S(text: "最后一段。", start: 7, end: 8)]) == "第一段修正第二段最后一段。")
        var repeated = SpeechTranscript()
        _ = repeated.update([S(text: "你好", start: 0, end: 1)])
        assert(repeated.update([S(text: "你好", start: 2, end: 3)]) == "你好你好")
        var english = SpeechTranscript()
        _ = english.update([S(text: "first", start: 0, end: 1)])
        assert(english.update([S(text: "second", start: 3, end: 4)]) == "first second")
        print("SpeechTranscript: 9 assertions passed")
    }
}
