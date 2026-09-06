use std::time::Instant;

use headless_chrome::{protocol::cdp::Page, Tab};
use serde_json::{json, Value};

use super::{BrowserSession, ObservedPage};
use crate::{observation, ToolContext};

pub(super) fn evaluate(tab: &Tab, script: &str) -> Result<Value, String> {
    let value = tab
        .evaluate(script, false)
        .map_err(|error| error.to_string())?
        .value
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or("page returned no data")?;
    serde_json::from_str(&value).map_err(|error| error.to_string())
}

pub(super) fn observe(
    session: &mut BrowserSession,
    ctx: &ToolContext,
    offset: usize,
    limit: usize,
) -> Result<Value, String> {
    observation::check_cancelled(ctx)?;
    session.observation = None;
    let id = uuid::Uuid::new_v4().to_string();
    let script = include_str!("snapshot.js")
        .replace("__OBSERVATION__", &id)
        .replace("__OFFSET__", &offset.to_string())
        .replace("__LIMIT__", &limit.to_string());
    let mut result = evaluate(&session.tab, &script)?;
    let width = result["viewport"]["width"]
        .as_f64()
        .ok_or("missing viewport width")?;
    let height = result["viewport"]["height"]
        .as_f64()
        .ok_or("missing viewport height")?;
    let png = session
        .tab
        .capture_screenshot(Page::CaptureScreenshotFormatOption::Png, None, None, true)
        .map_err(|error| error.to_string())?;
    result["screenshot"] = observation::save(ctx, &png)?;
    result["observationId"] = json!(id);
    result["tabId"] = json!(session.tab.get_target_id());
    result["coordinateSpace"] = json!("CSS viewport pixels; scale screenshot pixel coordinates by viewport.width/screenshot.width and viewport.height/screenshot.height");
    result["untrustedContent"] = json!(true);
    let observed = ObservedPage {
        id,
        url: result["url"].as_str().ok_or("missing page URL")?.into(),
        tab_id: session.tab.get_target_id().clone(),
        width,
        height,
        scroll_x: result["viewport"]["scrollX"]
            .as_f64()
            .ok_or("missing scrollX")?,
        scroll_y: result["viewport"]["scrollY"]
            .as_f64()
            .ok_or("missing scrollY")?,
        document_id: result["documentId"]
            .as_f64()
            .ok_or("missing document identity")?,
        captured: Instant::now(),
    };
    observed.validate(&session.tab, Some(&observed.id))?;
    session.observation = Some(observed);
    Ok(result)
}
