//! Opt-in native acceptance tests. Never opens a real mailbox or sends anything.
#![cfg(target_os = "macos")]

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use miniq_protocol::ComputerPermissionState;
use miniq_tools::{desktop_permissions, AppAutomationTool, Tool, ToolContext};
use serde_json::{json, Value};

#[path = "support/app_fixture.rs"]
mod fixture;
use fixture::Fixture;

#[path = "support/file_picker.rs"]
mod file_picker;
use file_picker::{file_columns, select_file_control};

#[path = "support/process_events.rs"]
mod process_events;

fn preflight(screen_capture: bool) {
    assert_eq!(
        std::env::var("MINIQ_RUN_APP_AUTOMATION_UI_TEST").as_deref(),
        Ok("1"),
        "NOT RUN: set MINIQ_RUN_APP_AUTOMATION_UI_TEST=1 to allow synthetic fixture windows"
    );
    let permissions = desktop_permissions();
    assert_eq!(permissions.accessibility, ComputerPermissionState::Granted,
        "NOT RUN: Accessibility is not granted to this test process ({}). No privacy prompt was requested. See docs/testing/app-automation.md.",
        permissions.executable);
    if screen_capture {
        assert_eq!(permissions.screen_recording, ComputerPermissionState::Granted,
            "NOT RUN: Screen Recording is not granted to this test process ({}). No privacy prompt was requested.",
            permissions.executable);
    }
}

fn target_input(fixture: &Fixture, action: &str) -> Value {
    json!({"action": action, "windowId": fixture.target["windowId"], "pid": fixture.target["pid"]})
}

async fn inspect_tree(
    tool: &AppAutomationTool,
    ctx: &ToolContext,
    fixture: &Fixture,
) -> (String, Vec<Value>) {
    inspect_matching(tool, ctx, fixture, None, None).await
}

async fn inspect_matching(
    tool: &AppAutomationTool,
    ctx: &ToolContext,
    fixture: &Fixture,
    branch: Option<(&str, &str)>,
    predicate: Option<&dyn Fn(&Value) -> bool>,
) -> (String, Vec<Value>) {
    let mut queue = VecDeque::from([(branch.map(|(_, parent)| parent.to_owned()), 0usize)]);
    let mut observation = branch.map(|(observation, _)| observation.to_owned());
    let mut elements = Vec::new();
    let mut visited = HashSet::new();
    let mut pages = 0;
    while let Some((parent, offset)) = queue.pop_front() {
        let mut input = target_input(fixture, "inspect");
        input["limit"] = json!(fixture.page_limit);
        input["offset"] = json!(offset);
        if let Some(id) = &observation {
            input["observationId"] = json!(id);
        }
        if let Some(id) = &parent {
            input["parentId"] = json!(id);
        }
        let output = tool
            .execute(ctx, input)
            .await
            .expect("inspect fixture controls");
        let returned = output["observationId"]
            .as_str()
            .expect("observation id")
            .to_owned();
        if let Some(id) = &observation {
            assert_eq!(&returned, id, "Pagination changed snapshot");
        }
        observation = Some(returned);
        let page = &output;
        let children = page["elements"].as_array().expect("paginated elements");
        assert!(
            children.len() <= fixture.page_limit,
            "Page size was not honored"
        );
        for element in children {
            let id = element["id"].as_str().expect("element id").to_owned();
            if visited.insert(id.clone()) {
                if element["childCount"].as_u64().unwrap_or(0) > 0 {
                    queue.push_back((Some(id), 0));
                }
                let mut element = element.clone();
                element["_testParentId"] = page["parentId"].clone();
                elements.push(element);
                if predicate.is_some_and(|matches| matches(elements.last().unwrap())) {
                    return (observation.unwrap(), elements);
                }
            }
        }
        if let Some(next) = page["nextOffset"].as_u64() {
            assert!(next > offset as u64, "Pagination failed to advance");
            queue.push_back((parent, next as usize));
        }
        pages += 1;
        assert!(pages < 1000, "Unexpected fixture AX tree cycle");
    }
    if branch.is_none() && predicate.is_none() {
        assert!(pages > 1, "Acceptance fixture must exercise pagination");
    }
    (observation.expect("initial observation"), elements)
}

fn find_element<'a>(elements: &'a [Value], identifier: &str) -> &'a Value {
    elements
        .iter()
        .find(|element| element["identifier"] == identifier)
        .unwrap_or_else(|| {
            panic!(
                "Missing fixture element {identifier}; {} nodes inspected",
                elements.len()
            )
        })
}

async fn fixture_windows(
    tool: &AppAutomationTool,
    ctx: &ToolContext,
    fixture: &Fixture,
) -> Vec<Value> {
    let mut input = json!({"action":"windows", "limit":2});
    let mut result = Vec::new();
    loop {
        let output = tool.execute(ctx, input.clone()).await.expect("window page");
        result.extend(
            output["windows"]
                .as_array()
                .expect("window list")
                .iter()
                .filter(|window| window["pid"] == fixture.target["pid"])
                .cloned(),
        );
        let Some(next) = output["nextOffset"].as_u64() else {
            break;
        };
        input["offset"] = json!(next);
        input["observationId"] = output["observationId"].clone();
    }
    result
}

async fn action(
    tool: &AppAutomationTool,
    ctx: &ToolContext,
    fixture: &Fixture,
    kind: &str,
    identifier: &str,
    text: Option<&str>,
) -> String {
    let (observation, elements) = inspect_matching(
        tool,
        ctx,
        fixture,
        None,
        Some(&|element| element["identifier"] == identifier),
    )
    .await;
    let element = find_element(&elements, identifier);
    let mut input = element_input(fixture, kind);
    input["observationId"] = json!(observation);
    input["elementId"] = element["id"].clone();
    if let Some(text) = text {
        input["value"] = json!({"text":text});
    }
    tool.execute(ctx, input)
        .await
        .expect("background fixture action");
    observation
}

fn element_input(fixture: &Fixture, kind: &str) -> Value {
    if kind.starts_with("AX") {
        let mut input = target_input(fixture, "invoke");
        input["axAction"] = json!(kind);
        input
    } else {
        target_input(fixture, kind)
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires opt-in and macOS Accessibility; synthetic native UI acceptance"]
async fn background_app_actions_preserve_foreground_and_cursor() {
    preflight(false);
    let fixture = Fixture::launch();
    let tool = AppAutomationTool::default();
    let mut ctx = ToolContext::new(fixture.directory.path().to_owned());
    ctx.observation_dir = fixture.directory.path().join("observations");
    assert!(
        fixture_windows(&tool, &ctx, &fixture)
            .await
            .iter()
            .any(|window| window["windowId"] == fixture.target["windowId"]
                && (window["title"] == "miniQ Fixture Target" || window["title"] == "")),
        "The target PID/window pair was missing from all window pages"
    );
    let before = fixture.probe();
    let old_observation = action(
        &tool,
        &ctx,
        &fixture,
        "setValue",
        "fixture-subject",
        Some("Updated 中文 subject"),
    )
    .await;
    fixture.assert_effect("subject", json!("Updated 中文 subject"));
    assert_eq!(
        fixture.probe(),
        before,
        "AX setValue moved the cursor or changed the foreground app"
    );
    action(
        &tool,
        &ctx,
        &fixture,
        "setValue",
        "fixture-body",
        Some("Hello 团队\nSynthetic attachment test."),
    )
    .await;
    fixture.assert_effect("body", json!("Hello 团队\nSynthetic attachment test."));
    action(&tool, &ctx, &fixture, "AXPress", "fixture-increment", None).await;
    fixture.assert_effect("presses", json!(1));
    assert_eq!(
        fixture.probe(),
        before,
        "AX actions moved the cursor or changed the foreground app"
    );

    let (_, elements) = inspect_tree(&tool, &ctx, &fixture).await;
    assert_eq!(
        find_element(&elements, "fixture-subject")["value"],
        "Updated 中文 subject"
    );
    assert_eq!(
        find_element(&elements, "fixture-body")["value"],
        "Hello 团队\nSynthetic attachment test."
    );
    let protected = elements
        .iter()
        .find(|element| element["subrole"] == "AXSecureTextField")
        .expect("Secure fixture field remains discoverable without its value");
    assert_eq!(protected["protected"], true);
    assert!(protected["value"].is_null());
    assert!(
        !serde_json::to_string(&elements)
            .unwrap()
            .contains("miniq-fixture-secret-never-expose"),
        "The AX observation exposed a password field value"
    );
    let mut stale = element_input(&fixture, "AXPress");
    stale["observationId"] = json!(old_observation);
    stale["elementId"] = find_element(&elements, "fixture-increment")["id"].clone();
    let error = tool
        .execute(&ctx, stale)
        .await
        .expect_err("stale observation must be rejected");
    assert!(
        error.to_string().contains("observation"),
        "Unexpected stale rejection: {error}"
    );
    fixture.assert_effect("presses", json!(1));
    tool.execute(&ctx, target_input(&fixture, "release"))
        .await
        .expect("release fixture lease");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires opt-in, macOS Accessibility and Screen Recording; captures only synthetic fixture"]
async fn background_app_screenshot_captures_target_window() {
    preflight(true);
    let fixture = Fixture::launch();
    let tool = AppAutomationTool::default();
    let mut ctx = ToolContext::new(fixture.directory.path().to_owned());
    ctx.observation_dir = fixture.directory.path().join("observations");
    let before = fixture.probe();
    let output = tool
        .execute(&ctx, target_input(&fixture, "screenshot"))
        .await
        .expect("target screenshot");
    assert!(output["screenshot"]["width"]
        .as_u64()
        .is_some_and(|width| width > 0));
    assert!(output["screenshot"]["height"]
        .as_u64()
        .is_some_and(|height| height > 0));
    let images = tool.output_images(&ctx, &output);
    assert_eq!(images.len(), 1, "Screenshot must be delivered to the model");
    let image = image::open(&images[0].path)
        .expect("valid screenshot PNG")
        .to_rgba8();
    assert_eq!(json!(image.width()), output["screenshot"]["width"]);
    assert_eq!(json!(image.height()), output["screenshot"]["height"]);
    let colors: HashSet<_> = image.pixels().map(|pixel| pixel.0).collect();
    assert!(
        colors.len() > 16,
        "Target screenshot is blank or unavailable"
    );
    assert_eq!(
        fixture.probe(),
        before,
        "Window capture changed foreground or cursor"
    );
    tool.execute(&ctx, target_input(&fixture, "release"))
        .await
        .expect("release fixture lease");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires opt-in and macOS Accessibility; synthetic native file picker acceptance"]
async fn background_app_file_picker_attaches_synthetic_file() {
    preflight(false);
    let mut fixture = Fixture::launch();
    let tool = AppAutomationTool::default();
    let ctx = ToolContext::new(fixture.directory.path().to_owned());
    let files = fixture.directory.path().join("fixture-files");
    std::fs::create_dir(&files).expect("synthetic attachment directory");
    let file = files.join("fixture-attachment.txt");
    std::fs::write(&file, "Synthetic attachment. No user or mailbox data.").expect("fixture file");
    let before = fixture.probe();
    let (observation, elements) = inspect_matching(
        &tool,
        &ctx,
        &fixture,
        None,
        Some(&|element| element["identifier"] == "fixture-attachment-button"),
    )
    .await;
    let mut input = element_input(&fixture, "AXPress");
    input["observationId"] = json!(observation);
    input["elementId"] = find_element(&elements, "fixture-attachment-button")["id"].clone();
    if let Err(error) = tool.execute(&ctx, input).await {
        assert!(
            error.to_string().contains("app_action_unconfirmed"),
            "Open picker failed: {error}"
        );
    }
    // A cold file-panel service can exceed AX's reply timeout. Observe whether
    // that one press applied; never replay it on an ambiguous response.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut pickers = loop {
        let windows: Vec<_> = fixture_windows(&tool, &ctx, &fixture)
            .await
            .into_iter()
            .filter(|window| {
                window["windowId"] != fixture.target["windowId"]
                    && (window["title"] == "miniQ Fixture Attachment Picker"
                        || window["title"] == "")
            })
            .collect();
        if !windows.is_empty() {
            break windows;
        }
        assert!(
            Instant::now() < deadline,
            "File picker did not open after the single press"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(
        pickers.len(),
        1,
        "New native file picker window must be unambiguous"
    );
    fixture.target = pickers.remove(0);
    fixture.page_limit = 40;
    select_file_control(&tool, &ctx, &fixture, "fixture-files").await;
    select_file_control(&tool, &ctx, &fixture, "fixture-attachment.txt").await;
    let (_, preview) = file_columns(&tool, &ctx, &fixture).await;
    assert!(
        preview.iter().any(|element| {
            element["role"] == "AXStaticText" && element["value"] == "fixture-attachment.txt"
        }),
        "The selected file must appear in the native preview before attaching"
    );
    let (observation, elements) = inspect_matching(
        &tool,
        &ctx,
        &fixture,
        None,
        Some(&|element| element["title"] == "Attach fixture"),
    )
    .await;
    let attach = elements
        .iter()
        .find(|element| element["title"] == "Attach fixture")
        .expect("Attach button missing in synthetic picker");
    assert_eq!(
        attach["enabled"], true,
        "Attachment is not ready to confirm"
    );
    let mut input = element_input(&fixture, "AXPress");
    input["observationId"] = json!(observation);
    input["elementId"] = attach["id"].clone();
    tool.execute(&ctx, input)
        .await
        .expect("select synthetic attachment");
    fixture.assert_effect("attachment", json!("fixture-attachment.txt"));
    assert_eq!(
        fixture.probe(),
        before,
        "Native picker changed foreground or pointer"
    );
    tool.execute(&ctx, target_input(&fixture, "release"))
        .await
        .expect("release fixture lease");
}
