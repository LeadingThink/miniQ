use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

#[derive(Default)]
struct MockDriver {
    requests: Mutex<Vec<BrowserDriverRequest>>,
    closed: AtomicBool,
    fail_next_click: AtomicBool,
    fail_next_observation: AtomicBool,
    screenshot: Option<String>,
    tabs: bool,
}

impl MockDriver {
    fn requests(&self) -> Vec<BrowserDriverRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl BrowserDriver for MockDriver {
    async fn execute(
        &self,
        request: BrowserDriverRequest,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<BrowserDriverResponse, String> {
        if cancellation.is_cancelled() {
            return Err("cancelled".into());
        }
        self.requests.lock().unwrap().push(request.clone());
        if request.operation == "click" && self.fail_next_click.swap(false, Ordering::SeqCst) {
            return Err("embedded browser navigation interrupted after dispatch".into());
        }
        if self.fail_next_observation.swap(false, Ordering::SeqCst) {
            return Err("page changed while capturing screenshot".into());
        }
        if request.operation == "close" {
            self.closed.store(true, Ordering::SeqCst);
            return Ok(BrowserDriverResponse {
                capabilities: capabilities(),
                result: json!({"closed": true}),
            });
        }
        let observation_id = request.arguments["nextObservationId"]
            .as_str()
            .unwrap_or("observation")
            .to_string();
        let mut result = json!({
            "observationId": observation_id,
            "url": request.arguments.get("url").and_then(Value::as_str).unwrap_or("https://example.com/"),
            "tabId": "embedded-main",
            "documentId": "document-1",
            "viewport": {"width": 1024.0, "height": 768.0, "scrollX": 0.0, "scrollY": 0.0},
            "items": [],
            "textLines": [],
        });
        let mut capabilities = capabilities();
        capabilities.screenshot = self.screenshot.is_some();
        capabilities.tabs = self.tabs;
        if request.operation == "screenshot"
            || request.arguments["includeScreenshot"] == json!(true)
        {
            if let Some(encoded) = &self.screenshot {
                result["screenshotBase64"] = json!(encoded);
            }
        }
        Ok(BrowserDriverResponse {
            capabilities,
            result,
        })
    }
}

fn capabilities() -> BrowserCapabilities {
    BrowserCapabilities {
        navigation_control: true,
        dom_snapshot: true,
        screenshot: false,
        tabs: false,
        pointer_input: true,
        keyboard_input: true,
        select_input: true,
    }
}

fn context(driver: Arc<MockDriver>) -> ToolContext {
    ToolContext::new(std::env::temp_dir()).with_browser(Some(driver))
}

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
        json!({"action":"resize","width":0,"height":100}),
        json!({"action":"resize","width":100}),
        json!({"action":"setVisible"}),
    ] {
        assert!(BrowserInput::parse(input).is_err());
    }
    let schema = input::schema();
    assert_eq!(schema["properties"]["limit"]["maximum"], 500.0);
    assert_eq!(schema["properties"]["limit"]["default"], 100);
    assert_eq!(schema["properties"]["values"]["items"]["type"], "string");
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["properties"]["x"]["minimum"], 0.0);
}

#[test]
fn select_accepts_explicit_values_for_multi_selects() {
    let input = BrowserInput::parse(json!({
        "action": "select",
        "observationId": "frame",
        "target": "rpa-frame-1",
        "values": ["early", "growth"]
    }))
    .unwrap();
    assert_eq!(
        input.values.as_deref(),
        Some(["early".to_owned(), "growth".to_owned()].as_slice())
    );
    assert!(BrowserInput::parse(json!({
        "action": "select",
        "observationId": "frame",
        "target": "rpa-frame-1",
        "text": ["early", "growth"]
    }))
    .is_err());
}

#[tokio::test]
async fn delegates_browser_management_operations() {
    let driver = Arc::new(MockDriver::default());
    let context = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    tool.execute(&context, json!({"action":"currentUrl"}))
        .await
        .unwrap();
    tool.execute(&context, json!({"action":"stop"}))
        .await
        .unwrap();
    tool.execute(&context, json!({"action":"setVisible","visible":false}))
        .await
        .unwrap();
    tool.execute(
        &context,
        json!({"action":"resize","width":800,"height":600}),
    )
    .await
    .unwrap();
    let operations = driver
        .requests()
        .into_iter()
        .map(|request| request.operation)
        .collect::<Vec<_>>();
    assert_eq!(operations, ["currentUrl", "stop", "setVisible", "resize"]);
}

#[tokio::test]
async fn delegates_to_the_embedded_driver_and_forwards_expected_observation() {
    let driver = Arc::new(MockDriver::default());
    let context = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    let opened = tool
        .execute(
            &context,
            json!({"action":"open","url":"https://example.com/"}),
        )
        .await
        .unwrap();
    assert_eq!(opened["previewMode"], "embedded-webview");
    assert_eq!(opened["browserSessionId"], context.task_scope);

    tool.execute(
        &context,
        json!({
            "action":"click",
            "target":"button-1",
            "observationId":opened["observationId"],
        }),
    )
    .await
    .unwrap();
    let requests = driver.requests();
    assert_eq!(requests[0].session_id, context.task_scope);
    assert_eq!(
        requests[1].arguments["expectedObservation"]["url"],
        "https://example.com/"
    );
    assert_eq!(
        requests[1].arguments["expectedObservation"]["tabId"],
        "embedded-main"
    );
    assert_eq!(
        requests[1].arguments["expectedObservation"]["documentId"],
        "document-1"
    );
    assert_eq!(
        requests[1].arguments["expectedObservation"]["viewport"]["width"],
        1024.0
    );
}

#[tokio::test]
async fn rejects_stale_observations_before_delegating() {
    let driver = Arc::new(MockDriver::default());
    let context = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    tool.execute(
        &context,
        json!({"action":"open","url":"https://example.com/"}),
    )
    .await
    .unwrap();
    let error = tool
        .execute(
            &context,
            json!({"action":"click","target":"button-1","observationId":"old"}),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("stale observation"));
    assert_eq!(driver.requests().len(), 1);
}

#[tokio::test]
async fn invalidates_an_observation_when_a_mutation_fails_after_dispatch() {
    let driver = Arc::new(MockDriver::default());
    let context = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    let opened = tool
        .execute(
            &context,
            json!({"action":"open","url":"https://example.com/"}),
        )
        .await
        .unwrap();
    driver.fail_next_click.store(true, Ordering::SeqCst);
    let error = tool
        .execute(
            &context,
            json!({"action":"click","target":"button-1","observationId":opened["observationId"]}),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("navigation interrupted"));

    // The click may already have reached the page, so replaying the same
    // observation must be rejected until the model obtains a fresh snapshot.
    let retry = tool
        .execute(
            &context,
            json!({"action":"click","target":"button-1","observationId":opened["observationId"]}),
        )
        .await
        .unwrap_err();
    assert!(retry.to_string().contains("observe the page before acting"));
}

#[tokio::test]
async fn rejects_capabilities_the_driver_does_not_offer() {
    let driver = Arc::new(MockDriver::default());
    let context = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    tool.execute(
        &context,
        json!({"action":"open","url":"https://example.com/"}),
    )
    .await
    .unwrap();
    let error = tool
        .execute(&context, json!({"action":"screenshot"}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("does not support screenshot"));
    assert_eq!(driver.requests().len(), 1);
}

#[tokio::test]
async fn discovers_an_existing_user_page_before_any_model_open() {
    let driver = Arc::new(MockDriver {
        tabs: true,
        ..Default::default()
    });
    let context = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    tool.execute(&context, json!({"action":"tabs"}))
        .await
        .unwrap();
    let observed = tool
        .execute(
            &context,
            json!({"action":"snapshot","tabId":"embedded-main"}),
        )
        .await
        .unwrap();
    // Listing tabs does not invalidate the page that was just observed.
    tool.execute(&context, json!({"action":"tabs"}))
        .await
        .unwrap();
    tool.execute(
        &context,
        json!({"action":"click","target":"button-1","observationId":observed["observationId"]}),
    )
    .await
    .unwrap();
    let requests = driver.requests();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.operation.as_str())
            .collect::<Vec<_>>(),
        ["tabs", "snapshot", "tabs", "click"]
    );
    assert_eq!(requests[1].arguments["tabId"], "embedded-main");
    assert_eq!(
        requests[3].arguments["expectedObservation"]["tabId"],
        "embedded-main"
    );
}

#[tokio::test]
async fn first_snapshot_discovers_capabilities_without_navigating() {
    let driver = Arc::new(MockDriver::default());
    let context = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    tool.execute(&context, json!({"action":"snapshot"}))
        .await
        .unwrap();
    assert_eq!(driver.requests()[0].operation, "snapshot");
    assert!(tool
        .execute(&context, json!({"action":"screenshot"}))
        .await
        .unwrap_err()
        .to_string()
        .contains("does not support screenshot"));
    assert_eq!(driver.requests().len(), 1);
}

#[tokio::test]
async fn failed_visual_observation_invalidates_previous_click_targets() {
    let driver = Arc::new(MockDriver {
        screenshot: Some(String::new()),
        ..Default::default()
    });
    let context = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    let opened = tool
        .execute(
            &context,
            json!({"action":"open","url":"https://example.com/"}),
        )
        .await
        .unwrap();
    driver.fail_next_observation.store(true, Ordering::SeqCst);
    let error = tool
        .execute(&context, json!({"action":"screenshot"}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("page changed"));
    let error = tool
        .execute(
            &context,
            json!({
                "action":"click", "target":"button-1", "observationId":opened["observationId"],
            }),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("observe the page before acting"));
    assert_eq!(driver.requests().len(), 2);
}

#[tokio::test]
async fn screenshot_requests_deliver_image_attachments_without_base64_in_model_text() {
    let directory = tempfile::tempdir().unwrap();
    let image = image::RgbaImage::new(32, 24);
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).unwrap();
    let driver = Arc::new(MockDriver {
        screenshot: Some(base64::engine::general_purpose::STANDARD.encode(png.get_ref())),
        ..Default::default()
    });
    let context = context(driver).with_observations(directory.path().into());
    let tool = BrowserAutomationTool::default();
    let opened = tool
        .execute(
            &context,
            json!({"action":"open","url":"https://example.com/"}),
        )
        .await
        .unwrap();
    assert_eq!(opened["capabilities"]["screenshot"], true);
    assert_eq!(opened["imageAttached"], false);
    assert!(tool.output_images(&context, &opened).is_empty());

    for input in [
        json!({"action":"screenshot"}),
        json!({"action":"snapshot","includeScreenshot":true}),
    ] {
        let output = tool.execute(&context, input).await.unwrap();
        assert_eq!(output["imageAttached"], true);
        assert_eq!(output["screenshot"]["width"], 32);
        assert_eq!(output["screenshot"]["height"], 24);
        assert!(output.get("screenshotBase64").is_none());
        let attachments = tool.output_images(&context, &output);
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].mime_type, "image/png");
        assert_eq!(std::fs::read(&attachments[0].path).unwrap(), *png.get_ref());
        tool.execute(
            &context,
            json!({
                "action":"click", "target":"button-1", "observationId":output["observationId"],
            }),
        )
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn task_scopes_are_forwarded_without_sharing_observations() {
    let driver = Arc::new(MockDriver::default());
    let first = context(driver.clone());
    let second = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    let first_page = tool
        .execute(
            &first,
            json!({"action":"open","url":"https://example.com/"}),
        )
        .await
        .unwrap();
    tool.execute(
        &second,
        json!({"action":"open","url":"https://example.org/"}),
    )
    .await
    .unwrap();
    let error = tool
        .execute(
            &second,
            json!({"action":"click","target":"button-1","observationId":first_page["observationId"]}),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("stale observation"));
    let requests = driver.requests();
    assert_ne!(requests[0].session_id, requests[1].session_id);
}

#[tokio::test]
async fn cancelled_calls_do_not_reach_the_driver() {
    let driver = Arc::new(MockDriver::default());
    let context = context(driver.clone());
    context.cancellation.cancel();
    let error = BrowserAutomationTool::default()
        .execute(
            &context,
            json!({"action":"open","url":"https://example.com/"}),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    let requests = driver.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].operation, "close");
    assert!(driver.closed.load(Ordering::SeqCst));
}
