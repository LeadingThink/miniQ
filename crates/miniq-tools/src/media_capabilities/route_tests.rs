use super::*;

#[test]
fn separate_protocol_sections_do_not_change_grok_reference_limits() {
    let html = r#"<h2>Grok 视频</h2><p><code>grok-imagine-video-1.5</code></p>
    <p>POST https://oneapi.zaiwenai.com/v1/videos/generations</p>
    <table><tr><td><code>reference_images</code></td><td>最多 7 张</td></tr></table>
    <h2>MiniMax-H3 视频</h2><p><code>minimax-h3-2k</code></p>
    <p>POST https://oneapi.zaiwenai.com/v1/videos/std/generations</p>
    <table><tr><td><code>reference_images</code></td><td>最多 5 张</td></tr></table>"#;
    let sections = generation_sections(html);
    assert_eq!(sections.len(), 2);
    let grok = sections
        .iter()
        .find(|(route, _)| route.ends_with("/videos/generations"))
        .unwrap();
    assert_eq!(
        constraints_from_document("generate_video", &grok.1).unwrap()["properties"]
            ["reference_images"]["maxItems"],
        7
    );
    let snapshot: MediaCapabilitySnapshot = serde_json::from_value(json!({
        "baseUrl":"https://example.test/v1","fetchedAt":1,
        "models":[
            {"id":"grok-imagine-video-1.5","kind":"video","maxDuration":15,"route":"/v1/videos/generations"},
            {"id":"minimax-h3-2k","kind":"video","maxDuration":15,"route":"/v1/videos/std/generations"}
        ],"schemas":{},"partial":false
    })).unwrap();
    assert_eq!(
        snapshot
            .select_model("video", "minimax-h3-2k", Some("minimax-h3-2k"))
            .unwrap(),
        "minimax-h3-2k"
    );
    assert_eq!(
        snapshot
            .select_model("video", "grok-imagine-video-1.5", None)
            .unwrap(),
        "grok-imagine-video-1.5"
    );
}
