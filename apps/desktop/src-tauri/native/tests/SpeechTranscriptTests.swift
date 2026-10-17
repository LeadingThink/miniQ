import Foundation
@main struct Tests {
    static func main() {
        typealias S = SpeechTranscript.Segment
        var transcript = SpeechTranscript()
        assert(transcript.update([S(text: "第一段", start: 0, end: 0)]) == "第一段")
        assert(transcript.update([S(text: "第一段修正", start: 0, end: 0)]) == "第一段修正")
        assert(transcript.update([S(text: "第一段修正", start: 1.17, end: 2.46)]) == "第一段修正")
        assert(transcript.update([S(text: "第二", start: 0, end: 0)]) == "第一段修正第二")
        assert(transcript.update([S(text: "第二段", start: 0, end: 0)]) == "第一段修正第二段")
        assert(transcript.update([S(text: "第二段", start: 4, end: 5)]) == "第一段修正第二段")
        assert(transcript.update([S(text: "最后一段", start: 0, end: 0)]) == "第一段修正第二段最后一段")
        assert(transcript.update([S(text: "最后一段。", start: 7, end: 8)]) == "第一段修正第二段最后一段。")
        assert(transcript.update([S(text: "第一段修正第二段最后一段。", start: 1.17, end: 8)]) == "第一段修正第二段最后一段。")
        assert(transcript.update([]) == "第一段修正第二段最后一段。")
        var repeated = SpeechTranscript()
        _ = repeated.update([S(text: "你好", start: 1, end: 2)])
        repeated.commit()
        assert(repeated.update([S(text: "你好", start: 0, end: 0)]) == "你好你好")
        var english = SpeechTranscript()
        _ = english.update([S(text: "first", start: 1, end: 2)])
        assert(english.update([S(text: "second", start: 0, end: 0)]) == "first second")
        assert(english.update([S(text: "second corrected", start: 3, end: 4)]) == "first second corrected")
        print("SpeechTranscript: 13 assertions passed")
    }
}
