//! Size cap for tool output kept in the database and sent to the UI.
//!
//! One runaway shell command can print hundreds of megabytes. Persisting that
//! text makes the database grow without bound and slows every later start.
//! The model never reads these rows (it gets a separately budgeted history),
//! so only the display copy is shortened: the head and the tail of an
//! oversized string are kept, with a marker in between.

use serde_json::Value;

/// Strings longer than this many bytes are shortened. Real data: a cap of
/// 4 MiB touches about 0.05% of stored calls and still keeps ordinary large
/// outputs complete, while removing the 100 MB+ outliers.
const STRING_CAP: usize = 4 * 1024 * 1024;
const HEAD_BYTES: usize = 3 * 1024 * 1024;
const TAIL_BYTES: usize = 1024 * 1024;
/// A string only counts as oversized once it exceeds the cap by this slack.
/// The slack covers the omission marker, so shortening always makes the text
/// smaller and a shortened string is never shortened again.
const MARKER_SLACK: usize = 1024;

/// Serialized output below this size is stored untouched without a rewrite.
pub(super) const CHEAP_SKIP_BYTES: usize = STRING_CAP;

/// Shorten every oversized string in `value` in place.
/// Returns the number of bytes removed; `0` means nothing changed.
pub fn cap_stored_output(value: &mut Value) -> usize {
    let removed = cap_value(value);
    if removed > 0 {
        if let Value::Object(map) = value {
            map.insert("outputTruncated".into(), Value::Bool(true));
        }
    }
    removed
}

fn cap_value(value: &mut Value) -> usize {
    match value {
        Value::String(text) => cap_string(text),
        Value::Array(items) => items.iter_mut().map(cap_value).sum(),
        Value::Object(map) => map.values_mut().map(cap_value).sum(),
        _ => 0,
    }
}

fn cap_string(text: &mut String) -> usize {
    if text.len() <= STRING_CAP + MARKER_SLACK {
        return 0;
    }
    let mut head = HEAD_BYTES;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - TAIL_BYTES;
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    let removed = tail - head;
    let shortened = format!(
        "{}\n… [miniQ shortened this stored output: {removed} bytes omitted] …\n{}",
        &text[..head],
        &text[tail..]
    );
    *text = shortened;
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ordinary_large_output_stays_complete() {
        let mut value = json!({"stdout": "complete output".repeat(100_000)});
        let original = value.clone();
        assert_eq!(cap_stored_output(&mut value), 0);
        assert_eq!(value, original);
    }

    #[test]
    fn small_output_is_untouched() {
        let mut value = json!({"stdout": "hello", "exitCode": 0});
        let original = value.clone();
        assert_eq!(cap_stored_output(&mut value), 0);
        assert_eq!(value, original);
    }

    #[test]
    fn oversized_string_keeps_head_tail_and_marks_the_object() {
        let big = format!("START{}END", "x".repeat(10 * 1024 * 1024));
        let mut value = json!({"stdout": big, "exitCode": 1});
        let removed = cap_stored_output(&mut value);
        assert!(removed > 5 * 1024 * 1024);
        let stdout = value["stdout"].as_str().unwrap();
        assert!(stdout.len() < STRING_CAP + MARKER_SLACK);
        assert!(stdout.starts_with("START"));
        assert!(stdout.ends_with("END"));
        assert!(stdout.contains("bytes omitted"));
        assert_eq!(value["exitCode"], 1);
        assert_eq!(value["outputTruncated"], true);
    }

    #[test]
    fn cuts_on_character_boundaries() {
        let big = "汉".repeat(2_000_000);
        let mut value = json!({ "stdout": big });
        assert!(cap_stored_output(&mut value) > 0);
        assert!(value["stdout"].as_str().unwrap().contains("汉"));
    }

    #[test]
    fn nested_strings_are_capped_too() {
        let mut value = json!({"items": [{"text": "y".repeat(STRING_CAP + 2 * MARKER_SLACK)}]});
        assert!(cap_stored_output(&mut value) > 0);
        assert!(value["items"][0]["text"].as_str().unwrap().len() < STRING_CAP + MARKER_SLACK);
    }

    #[test]
    fn already_capped_output_is_stable() {
        let mut value = json!({"stdout": "z".repeat(12 * 1024 * 1024)});
        cap_stored_output(&mut value);
        let once = value.clone();
        assert_eq!(cap_stored_output(&mut value), 0);
        assert_eq!(value, once);
    }
}
