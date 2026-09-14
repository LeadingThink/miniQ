//! Navigates only the current path column in the synthetic native file panel.

use super::{element_input, inspect_matching, target_input, Fixture};
use miniq_tools::{AppAutomationTool, Tool, ToolContext};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub(super) async fn select_file_control(
    tool: &AppAutomationTool,
    ctx: &ToolContext,
    fixture: &Fixture,
    label: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    let (observation, elements) = loop {
        let observed = file_columns(tool, ctx, fixture).await;
        if observed.1.iter().any(|element| names_file(element, label)) {
            break observed;
        }
        assert!(
            Instant::now() < deadline,
            "File panel did not load synthetic file {label}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let mut element = elements
        .iter()
        .find(|element| names_file(element, label))
        .expect("observed file name");
    loop {
        if element["selectionSettable"] == true {
            break;
        }
        element = elements
            .iter()
            .find(|parent| parent["id"] == element["_testParentId"])
            .unwrap_or_else(|| panic!("Synthetic file {label} has no selection control"));
    }
    let mut input = element_input(fixture, "select");
    input["observationId"] = json!(observation);
    input["elementId"] = element["id"].clone();
    if let Err(error) = tool.execute(ctx, input).await {
        // AppKit can change the selection before returning an AX error. Never
        // replay that mutation: the caller must verify the new contents and the
        // final attachment basename before this acceptance test can pass.
        let message = error.to_string();
        assert!(
            message.contains("app_action_unconfirmed"),
            "Unexpected file-selection failure: {message}"
        );
    }
}

fn names_file(element: &Value, label: &str) -> bool {
    element["value"] == label
        || element["title"] == label
        || element["description"]
            .as_str()
            .is_some_and(|description| description.contains(label))
}

pub(super) async fn file_columns(
    tool: &AppAutomationTool,
    ctx: &ToolContext,
    fixture: &Fixture,
) -> (String, Vec<Value>) {
    let (observation, elements) = inspect_matching(
        tool,
        ctx,
        fixture,
        None,
        Some(&|element| element["role"] == "AXBrowser"),
    )
    .await;
    let browser = elements
        .iter()
        .find(|element| element["role"] == "AXBrowser")
        .expect("Native file picker exposes its column browser");
    let mut input = target_input(fixture, "inspect");
    input["observationId"] = json!(observation);
    input["parentId"] = browser["id"].clone();
    input["limit"] = json!(fixture.page_limit);
    let mut columns = Vec::new();
    loop {
        let page = tool
            .execute(ctx, input.clone())
            .await
            .expect("browser columns");
        columns.extend(
            page["elements"]
                .as_array()
                .expect("column page")
                .iter()
                .cloned(),
        );
        let Some(next) = page["nextOffset"].as_u64() else {
            break;
        };
        input["offset"] = json!(next);
    }
    // AXColumns orders path columns left to right. Inspect the current, rightmost
    // directory; enumerating every ancestor would read unrelated /tmp entries.
    let current = columns
        .iter()
        .rfind(|column| column["role"] == "AXScrollArea")
        .expect("current native browser column");
    inspect_matching(
        tool,
        ctx,
        fixture,
        Some((&observation, current["id"].as_str().unwrap())),
        None,
    )
    .await
}
