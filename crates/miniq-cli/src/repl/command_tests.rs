use super::*;

#[test]
fn base64_matches_reference() {
    assert_eq!(base64_lite::encode(b""), "");
    assert_eq!(base64_lite::encode(b"f"), "Zg==");
    assert_eq!(base64_lite::encode(b"fo"), "Zm8=");
    assert_eq!(base64_lite::encode(b"foobar"), "Zm9vYmFy");
}

#[test]
fn usage_sums_known_calls() {
    let text = usage(&json!({"calls":[
        {"response":{"usage":{"input_tokens":7,"output_tokens":1,"cache_read_input_tokens":4}}},
        {"response":{"usage":{"prompt_tokens":3,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":1}}}},
        {"response":{"usage":null}}
    ]}));
    assert!(text.contains("input 10"));
    assert!(text.contains("output 2"));
    assert!(text.contains("(5 cached)"));
    assert!(text.contains("1 call(s) without usage"));
}

#[test]
fn commands_are_unique_and_include_context_tools() {
    let names: Vec<_> = COMMANDS.iter().map(|c| c.0).collect();
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), names.len());
    for name in ["/undo", "/compact", "/context"] {
        assert!(names.contains(&name), "{name}");
    }
}
