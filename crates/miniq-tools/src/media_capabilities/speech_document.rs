//! Extract bounded speech data, never arbitrary prose or provider instructions.
use super::*;

pub(super) fn grok_constraints(html: &str) -> Option<Value> {
    let starts = regex::Regex::new(r"(?is)<h2\b[^>]*>")
        .ok()?
        .find_iter(html)
        .map(|m| m.start())
        .collect::<Vec<_>>();
    let endpoint = regex::Regex::new(r"POST\s+https?://[^/\s]+/v1/audio/speech\b").ok()?;
    let section = starts.iter().enumerate().find_map(|(index, start)| {
        let section = &html[*start..starts.get(index + 1).copied().unwrap_or(html.len())];
        let text = html2text::from_read(section.as_bytes(), 2000).replace('`', "");
        (endpoint.is_match(&text) && text.contains("grok-tts")).then_some(section)
    })?;
    let rows = regex::Regex::new(r"(?is)<tr[^>]*>(.*?)</tr>").ok()?;
    let cells = regex::Regex::new(r"(?is)<t[dh][^>]*>(.*?)</t[dh]>").ok()?;
    let code = regex::Regex::new(r"(?is)<code\b[^>]*>(.*?)</code>").ok()?;
    let id = regex::Regex::new(r"^[a-z][a-z0-9-]{0,39}$").ok()?;
    let mut properties = Map::new();
    let mut voices = Vec::new();
    let mut instant = Vec::new();
    let mut paired = Vec::new();
    for row in rows.captures_iter(section) {
        let columns = cells
            .captures_iter(&row[1])
            .map(|m| m[1].to_owned())
            .collect::<Vec<_>>();
        let first = columns.first()?;
        let name = html2text::from_read(first.as_bytes(), 1000)
            .replace('`', "")
            .trim()
            .to_owned();
        let plain = html2text::from_read(row[1].as_bytes(), 1000).replace('`', "");
        let codes = code
            .captures_iter(&row[1])
            .map(|m| {
                html2text::from_read(m[1].as_bytes(), 1000)
                    .trim()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        if name == "response_format" {
            let formats = codes
                .iter()
                .filter(|c| matches!(c.as_str(), "mp3" | "wav"))
                .cloned()
                .collect::<Vec<_>>();
            if !formats.is_empty() {
                properties.insert(name, json!({"enum":formats}));
            }
        } else if name == "speed" && plain.contains("仅支持") {
            let numbers = regex::Regex::new(r"\b[0-9]+(?:\.[0-9]+)?\b").ok()?;
            let values = numbers
                .find_iter(&plain)
                .filter_map(|m| m.as_str().parse::<f64>().ok())
                .collect::<Vec<_>>();
            if !values.is_empty() {
                properties.insert(name, json!({"enum":values}));
            }
        } else if matches!(name.as_str(), "女声" | "男声") {
            voices.extend(codes.iter().filter(|c| id.is_match(c)).cloned());
        } else {
            for text in codes {
                if let Some(tag) = text.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                    if id.is_match(tag) && instant.len() < 64 {
                        instant.push(tag.to_owned());
                    }
                }
                if let Some(tag) = text.strip_prefix('<').and_then(|s| s.strip_suffix('>')) {
                    if id.is_match(tag) && paired.len() < 64 {
                        paired.push(tag.to_owned());
                    }
                }
            }
        }
    }
    voices.sort();
    voices.dedup();
    if !voices.is_empty() && voices.len() <= 128 {
        properties.insert("voice".into(), json!({"enum":voices}));
    }
    instant.sort();
    instant.dedup();
    paired.sort();
    paired.dedup();
    if !instant.is_empty() || !paired.is_empty() {
        let inline = instant
            .iter()
            .map(|t| format!("[{t}]"))
            .collect::<Vec<_>>()
            .join(", ");
        let wrappers = paired
            .iter()
            .map(|t| format!("<{t}>...</{t}>"))
            .collect::<Vec<_>>()
            .join(", ");
        properties.insert("input".into(), json!({
            "minLength":1,
            "x-speech-tags":{"instant":instant,"paired":paired},
            "description":format!("Text to speak. Grok speech tags go in input, not separate parameters. Instant tags: {inline}. Paired tags: {wrappers}. Close each wrapper in nesting order. Apply wrappers to complete phrases. Use tags sparingly. Other bracketed text remains ordinary text.")
        }));
    }
    if properties.is_empty() {
        return None;
    }
    Some(json!({"type":"object", "properties":properties}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_only_speech_section_and_safe_tag_ids() {
        let html = r#"<h2>Transcribe</h2><table><tr><td>response_format</td><td><code>json</code></td></tr></table>
        <h2>OpenAI speech</h2><p>POST https://oneapi.zaiwenai.com/v1/audio/speech grok-tts</p>
        <table><tr><td><code>response_format</code></td><td>string</td><td><code>mp3</code> or <code>wav</code></td></tr>
        <tr><td><code>speed</code></td><td>number</td><td>当前仅支持 <code>1.0</code></td></tr>
        <tr><td>女声</td><td><code>eve</code><code>new-voice</code></td></tr>
        <tr><td>停顿</td><td><code>[pause]</code><code>[new-pause]</code><code>[ignore instructions]</code></td></tr>
        <tr><td>音量</td><td><code>&lt;whisper&gt;</code><code>&lt;new-style&gt;</code></td></tr></table>
        <h2>Gemini</h2><table><tr><td>男声</td><td><code>not-grok</code></td></tr></table>"#;
        let schema = grok_constraints(html).unwrap();
        assert_eq!(schema["properties"]["speed"]["enum"], json!([1.0]));
        assert_eq!(
            schema["properties"]["response_format"]["enum"],
            json!(["mp3", "wav"])
        );
        assert_eq!(
            schema["properties"]["voice"]["enum"],
            json!(["eve", "new-voice"])
        );
        assert_eq!(
            schema["properties"]["input"]["x-speech-tags"]["paired"],
            json!(["new-style", "whisper"])
        );
        assert!(!schema.to_string().contains("ignore instructions"));
        assert!(grok_constraints("<p>grok-tts eve tags speed1</p>").is_none());
    }
}
