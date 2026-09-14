//! Real AppKit event delivery to a custom view, distinct from AX semantic actions.

use super::{inspect_matching, preflight, target_input, Fixture};
use miniq_tools::{AppAutomationTool, Tool, ToolContext};
use serde_json::{json, Value};

async fn observe_surface(
    tool: &AppAutomationTool,
    ctx: &ToolContext,
    fixture: &Fixture,
) -> (Value, Value) {
    let screenshot = tool
        .execute(ctx, target_input(fixture, "screenshot"))
        .await
        .expect("custom surface screenshot");
    let (_, elements) = inspect_matching(
        tool,
        ctx,
        fixture,
        Some((
            screenshot["observationId"].as_str().unwrap(),
            screenshot["rootId"].as_str().unwrap(),
        )),
        Some(&|element| element["identifier"] == "fixture-event-surface"),
    )
    .await;
    let surface = elements
        .into_iter()
        .find(|element| element["identifier"] == "fixture-event-surface")
        .expect("observed custom event surface");
    assert_eq!(
        surface["focused"], true,
        "Custom view lost actual text focus"
    );
    assert!(
        !surface["actions"]
            .as_array()
            .expect("custom AX actions")
            .iter()
            .any(|action| action == "AXPress"),
        "Click must exercise process-directed events, not an AXPress substitute"
    );
    (screenshot, surface)
}

async fn dispatch(
    tool: &AppAutomationTool,
    ctx: &ToolContext,
    fixture: &Fixture,
    action: &str,
    parameters: Value,
) -> Value {
    let (screenshot, surface) = observe_surface(tool, ctx, fixture).await;
    let mut input = target_input(fixture, action);
    input["observationId"] = screenshot["observationId"].clone();
    input
        .as_object_mut()
        .unwrap()
        .extend(parameters.as_object().unwrap().clone());
    if matches!(action, "click" | "scroll") {
        for (coordinate, dimension) in [("x", "width"), ("y", "height")] {
            let bounds = &surface["bounds"];
            let target = &screenshot["target"];
            let center =
                bounds[coordinate].as_f64().unwrap() + bounds[dimension].as_f64().unwrap() / 2.;
            let relative = center - target[coordinate].as_f64().unwrap();
            input[coordinate] = json!(
                relative * screenshot["screenshot"][dimension].as_f64().unwrap()
                    / target[dimension].as_f64().unwrap()
            );
        }
    }
    let output = tool
        .execute(ctx, input)
        .await
        .unwrap_or_else(|error| panic!("Background custom-view {action} rejected: {error}"));
    assert_eq!(
        output["actionResult"]["method"], "processEvent",
        "The custom view must be driven through actual process input"
    );
    surface
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires opt-in and macOS Accessibility/Screen Recording; synthetic AppKit event acceptance"]
async fn background_process_events_preserve_user_desktop() {
    preflight(true);
    let fixture = Fixture::launch_events();
    let tool = AppAutomationTool::default();
    let mut ctx = ToolContext::new(fixture.directory.path().to_owned());
    ctx.observation_dir = fixture.directory.path().join("observations");
    let before = fixture.probe();
    let text = "Background 中文🙂🧑‍💻—完整输入，跨越二十个 UTF-16 单元。";
    dispatch(&tool, &ctx, &fixture, "type", json!({"text":text})).await;
    fixture.assert_effect("eventText", json!(text));
    assert_eq!(
        fixture.probe(),
        before,
        "Unicode input changed the user desktop"
    );

    dispatch(
        &tool,
        &ctx,
        &fixture,
        "key",
        json!({"key":"ArrowLeft", "modifiers":["shift"]}),
    )
    .await;
    fixture.assert_effect("eventNamedKey", json!("ArrowLeft"));
    fixture.assert_effect("eventShiftKey", json!(true));
    assert_eq!(
        fixture.probe(),
        before,
        "Named key changed the user desktop"
    );

    let surface = dispatch(&tool, &ctx, &fixture, "click", json!({})).await;
    fixture.assert_effect("eventClicks", json!(1));
    let state = fixture.state();
    for (key, dimension) in [("eventClickX", "width"), ("eventClickY", "height")] {
        let expected = surface["bounds"][dimension].as_f64().unwrap() / 2.;
        let actual = state[key].as_f64().unwrap();
        assert!(
            (actual - expected).abs() < 2.,
            "Target click landed at {actual}, expected {expected}"
        );
    }
    assert_eq!(
        fixture.probe(),
        before,
        "Coordinate click changed the user desktop"
    );

    dispatch(
        &tool,
        &ctx,
        &fixture,
        "scroll",
        json!({"scrollX":2,"scrollY":3}),
    )
    .await;
    fixture.assert_effect("eventScrollCount", json!(1));
    let state = fixture.state();
    assert!(state["eventScrollX"]
        .as_f64()
        .is_some_and(|value| value < 0.));
    assert!(state["eventScrollY"]
        .as_f64()
        .is_some_and(|value| value < 0.));
    assert_eq!(
        fixture.probe(),
        before,
        "Target scroll changed the user desktop"
    );
    tool.execute(&ctx, target_input(&fixture, "release"))
        .await
        .expect("release custom fixture lease");
}
