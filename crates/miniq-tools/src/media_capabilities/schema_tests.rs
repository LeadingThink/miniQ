use super::*;

#[test]
fn documentation_tables_supply_changed_video_ranges_without_guessing() {
    let html = r#"<p>Example: 480p, 720p, 15 seconds.</p>
    <table><tr><td><code>duration</code></td><td>2 至 20 秒，默认 10</td></tr>
    <tr><td><code>reference_images</code></td><td>最多 5 张</td></tr></table>
    <table><tr><th>值</th><th>说明</th></tr><tr><td><code>720p</code></td><td>默认</td></tr><tr><td><code>1080p</code></td><td>高清</td></tr></table>
    <table><tr><td><code>16:9</code></td><td>横屏</td></tr><tr><td><code>9:16</code></td><td>竖屏</td></tr></table>"#;
    let schema = constraints_from_document("generate_video", html).unwrap();
    assert_eq!(schema["properties"]["duration"]["minimum"], 2);
    assert_eq!(schema["properties"]["duration"]["maximum"], 20);
    assert_eq!(schema["properties"]["duration"]["default"], 10);
    assert_eq!(schema["properties"]["reference_images"]["maxItems"], 5);
    assert_eq!(
        schema["properties"]["resolution"]["enum"],
        json!(["720p", "1080p"])
    );
    assert_eq!(
        schema["properties"]["aspect_ratio"]["enum"],
        json!(["16:9", "9:16"])
    );
    assert!(constraints_from_document("generate_video", "duration 1 15 480p 720p").is_none());
}

#[test]
fn openapi_reads_generation_post_and_resolves_local_references() {
    let document = json!({"paths":{
        "/v1/music/edits":{"post":{"requestBody":{"content":{"application/json":{"schema":{"properties":{"bad":{"type":"string"}}}}}}}},
        "/v1/music/generations":{"post":{"requestBody":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Music"}}}}}}
    },"components":{"schemas":{"Music":{"properties":{"weirdness":{"anyOf":[{"type":"number","maximum":0.4},{"type":"null"}]},"unknown":{"type":"string"}}}}}});
    let discovered = schema_for_tool(&document, "generate_music").unwrap();
    let merged = merge_tool_schema("generate_music", &discovered);
    assert_eq!(merged["properties"]["weirdness"]["maximum"], 0.4);
    assert!(merged.get("allOf").is_some());
    assert!(merged["properties"].get("unknown").is_none());
    assert!(merged["properties"].get("bad").is_none());
}

#[test]
fn dedicated_image_routes_cannot_be_selected_for_generic_image_generation() {
    let snapshot: MediaCapabilitySnapshot = serde_json::from_value(json!({
        "baseUrl":"https://example.test/v1", "fetchedAt":1,
        "models":[{"id":"midjourney","kind":"image","maxDuration":null}],
        "schemas":{},"partial":false
    }))
    .unwrap();
    assert!(snapshot
        .select_model("image", "midjourney", Some("midjourney"))
        .is_err());
    assert!(snapshot.select_model("image", "midjourney", None).is_err());
}
