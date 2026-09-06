use super::*;
use axum::{response::Html, routing::get, Router};

#[test]
fn url_policy_allows_only_web_pages() {
    for url in ["https://example.com", "http://127.0.0.1:3000"] {
        assert!(parse_web_url(url).is_ok());
    }
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://user:secret@example.com",
    ] {
        assert!(parse_web_url(url).is_err());
    }
}

#[test]
fn observations_are_low_risk_interactions_require_approval() {
    let tool = BrowserAutomationTool::default();
    let context = ToolContext::new(std::env::temp_dir());
    for action in ["snapshot", "screenshot", "status", "tabs", "close"] {
        assert_eq!(
            tool.evaluate_risk(&context, &json!({"action":action}))
                .level,
            RiskLevel::Low
        );
    }
    for action in ["click", "type", "drag", "newTab", "select", "press"] {
        assert_eq!(
            tool.evaluate_risk(&context, &json!({"action":action}))
                .level,
            RiskLevel::High
        );
    }
}

#[test]
fn validates_schema_limits_without_silent_clamping() {
    for input in [
        json!({"action":"snapshot","limit":0}),
        json!({"action":"snapshot","limit":501}),
        json!({"action":"wait","milliseconds":5001}),
        json!({"action":"unknown"}),
        json!({"action":"snapshot","offset":-1}),
        json!({"action":"snapshot","limit":1.5}),
        json!({"action":"snapshot","invented":true}),
        json!({"action":"click","x":-1,"y":0,"observationId":"frame"}),
        json!({"action":"snapshot","limit":null}),
    ] {
        assert!(BrowserInput::parse(input).is_err());
    }
    let schema = input::schema();
    assert_eq!(schema["properties"]["limit"]["maximum"], 500.0);
    assert_eq!(schema["properties"]["limit"]["default"], 100);
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["properties"]["x"]["minimum"], 0.0);
}

#[tokio::test]
async fn tasks_never_reuse_each_others_browser_slots() {
    let tool = BrowserAutomationTool::default();
    let first = ToolContext::new(std::env::temp_dir());
    let second = ToolContext::new(std::env::temp_dir());
    tool.execute(&first, json!({"action":"close"}))
        .await
        .unwrap();
    tool.execute(&second, json!({"action":"close"}))
        .await
        .unwrap();
    let sessions = tool.sessions.lock().unwrap();
    assert!(!Arc::ptr_eq(
        &sessions[&first.task_scope],
        &sessions[&second.task_scope]
    ));
}

#[tokio::test]
async fn cancelled_open_does_not_launch_chrome() {
    let context = ToolContext::new(std::env::temp_dir());
    context.cancellation.cancel();
    let tool = BrowserAutomationTool::default();
    let result = tool
        .execute(
            &context,
            json!({"action":"open","url":"https://example.com"}),
        )
        .await;
    assert!(result.unwrap_err().to_string().contains("cancelled"));
}

#[tokio::test]
#[ignore = "requires locally installed Chrome; only opens an isolated test fixture"]
async fn visible_browser_roundtrip() {
    let app = Router::new().route("/", get(|| async { Html(include_str!("fixture.html")) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let context =
        ToolContext::new(directory.path().into()).with_observations(directory.path().into());
    let tool = BrowserAutomationTool::default();
    let page = tool
        .execute(
            &context,
            json!({"action":"open","url":format!("http://{address}/"),"includeScreenshot":true}),
        )
        .await
        .unwrap();
    assert!(page["screenshot"]["width"].as_u64().unwrap() > 500);
    let attachments = tool.output_images(&context, &page);
    let scope = tool.approval_scope(&context, &json!({"action":"click","observationId":page["observationId"],"url":"https://spoofed.invalid"})).unwrap();
    assert_eq!(scope, format!("click:http://{address}"));
    let screenshot = image::open(&attachments[0].path).unwrap().to_rgb8();
    assert!(screenshot
        .pixels()
        .any(|pixel| i16::from(pixel.0[0]) - i16::from(pixel.0[1]) > 50));
    if let Ok(path) = std::env::var("MINIQ_BROWSER_TEST_ARTIFACTS") {
        std::fs::create_dir_all(&path).unwrap();
        std::fs::copy(
            &attachments[0].path,
            std::path::Path::new(&path).join("browser-observation.png"),
        )
        .unwrap();
    }
    let target = |page: &Value, tag: &str| {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["tag"] == tag)
            .unwrap()["target"]
            .clone()
    };
    let clicked = tool.execute(&context, json!({"action":"click","target":target(&page,"button"),"observationId":page["observationId"]})).await.unwrap();
    assert!(tool.output_images(&context, &clicked).is_empty());
    assert!(clicked["textLines"].to_string().contains("Completed"));
    assert!(tool.execute(&context, json!({"action":"click","target":target(&page,"button"),"observationId":page["observationId"]})).await.is_err());
    let page = tool
        .execute(&context, json!({"action":"snapshot"}))
        .await
        .unwrap();
    let typed = tool.execute(&context, json!({"action":"type","target":target(&page,"input"),"text":"你好 miniQ","observationId":page["observationId"]})).await.unwrap();
    assert!(typed["textLines"].to_string().contains("你好 miniQ"));
    let selected = tool.execute(&context, json!({"action":"select","target":target(&typed,"select"),"text":"b","observationId":typed["observationId"]})).await.unwrap();
    assert!(selected["textLines"].to_string().contains("Selected b"));
    let page = tool
        .execute(&context, json!({"action":"snapshot","limit":1,"offset":0}))
        .await
        .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["hasMore"], true);
    let second = tool
        .execute(
            &context,
            json!({"action":"newTab","url":format!("http://{address}/")}),
        )
        .await
        .unwrap();
    assert_ne!(second["tabId"], page["tabId"]);
    let tabs = tool
        .execute(&context, json!({"action":"tabs"}))
        .await
        .unwrap();
    assert!(tabs["tabs"].as_array().unwrap().len() >= 2);
    let switched = tool
        .execute(
            &context,
            json!({"action":"switchTab","tabId":page["tabId"]}),
        )
        .await
        .unwrap();
    assert!(switched["textLines"].to_string().contains("Completed"));
    check_visual_actions(&tool, &context, switched).await;
    check_changed_document(&tool, &context).await;
    tool.execute(
        &context,
        json!({"action":"closeTab","tabId":second["tabId"]}),
    )
    .await
    .unwrap();
    tool.execute(&context, json!({"action":"close"}))
        .await
        .unwrap();
    server.abort();
}

async fn check_changed_document(tool: &BrowserAutomationTool, context: &ToolContext) {
    let page = tool
        .execute(context, json!({"action":"snapshot"}))
        .await
        .unwrap();
    let tab = tool.sessions.lock().unwrap()[&context.task_scope]
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .tab
        .clone();
    tab.evaluate("scrollTo(0,0)", false).unwrap();
    assert!(tool
        .execute(
            context,
            json!({"action":"click","x":1,"y":1,"observationId":page["observationId"]})
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("scroll"));
    let page = tool
        .execute(context, json!({"action":"snapshot"}))
        .await
        .unwrap();
    tab.reload(false, None).unwrap();
    tab.wait_until_navigated().unwrap();
    assert!(tool
        .execute(
            context,
            json!({"action":"click","x":1,"y":1,"observationId":page["observationId"]})
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("document"));
    let page = tool
        .execute(context, json!({"action":"snapshot"}))
        .await
        .unwrap();
    let target = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["label"] == "Read-only field")
        .unwrap()["target"]
        .clone();
    assert!(tool.execute(context, json!({"action":"type","target":target,"text":"unsafe","observationId":page["observationId"]})).await.unwrap_err().to_string().contains("editable"));
    tab.evaluate("scrollTo(0,document.body.scrollHeight)", false)
        .unwrap();
    let page = tool
        .execute(context, json!({"action":"screenshot"}))
        .await
        .unwrap();
    let image = image::open(&tool.output_images(context, &page)[0].path)
        .unwrap()
        .to_rgb8();
    assert!(
        image.pixels().any(|pixel| pixel.0 == [112, 45, 189]),
        "screenshot must show the scrolled viewport, not the document top"
    );
}

async fn check_visual_actions(
    tool: &BrowserAutomationTool,
    context: &ToolContext,
    mut page: Value,
) {
    let target = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["text"] == "Coordinate target")
        .unwrap();
    let x = target["bounds"]["x"].as_f64().unwrap() + 30.;
    let y = target["bounds"]["y"].as_f64().unwrap() + 30.;
    for (action, expected) in [
        ("click", "Coordinate clicked"),
        ("doubleClick", "Double clicked"),
        ("drag", "Dragged"),
    ] {
        page = tool.execute(context,json!({"action":action,"x":x,"y":y,"endX":x+120.,"endY":y+20.,"observationId":page["observationId"],"includeScreenshot":true})).await.unwrap();
        assert!(
            page["textLines"].to_string().contains(expected),
            "{action}: {page}"
        );
        assert_eq!(tool.output_images(context, &page).len(), 1);
    }
    let target = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["text"] == "Editable content")
        .unwrap()["target"]
        .clone();
    page = tool.execute(context,json!({"action":"type","target":target,"text":"Edited rich text","observationId":page["observationId"]})).await.unwrap();
    assert!(page["textLines"].to_string().contains("Edited rich text"));
    assert!(!page["items"].to_string().contains("not-in-dom-snapshot"));
    page = tool.execute(context,json!({"action":"scroll","x":x,"y":y,"deltaY":500,"observationId":page["observationId"]})).await.unwrap();
    assert!(page["viewport"]["scrollY"].as_f64().unwrap() > 0.);
    assert!(tool
        .execute(
            context,
            json!({"action":"click","x":-1,"y":0,"observationId":page["observationId"]})
        )
        .await
        .is_err());
}
