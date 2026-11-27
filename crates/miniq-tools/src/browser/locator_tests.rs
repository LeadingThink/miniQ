use super::*;

#[test]
fn element_actions_accept_locators_without_coordinates_or_targets() {
    for action in [
        "click",
        "doubleClick",
        "move",
        "scroll",
        "type",
        "select",
        "press",
    ] {
        let mut value = json!({
            "action": action, "observationId": "observed",
            "locator": {"by":"role", "value":"textbox", "name":"姓名"}
        });
        match action {
            "type" => value["text"] = json!("张三"),
            "select" => value["values"] = json!(["early"]),
            "press" => value["key"] = json!("Enter"),
            _ => {}
        }
        assert!(BrowserInput::parse(value).is_ok(), "{action}");
    }
    assert!(BrowserInput::parse(json!({
        "action":"drag", "observationId":"observed",
        "locator":{"by":"testId", "value":"source"},
        "endLocator":{"by":"css", "value":"#destination"}
    }))
    .is_ok());
}

#[test]
fn locator_validation_rejects_ambiguous_or_invalid_argument_shapes() {
    let base = json!({"action":"click", "observationId":"observed", "locator":{"by":"role", "value":"button"}});
    for change in [
        json!({"locator":{"by":"unknown", "value":"save"}}),
        json!({"locator":{"by":"css", "value":""}}),
        json!({"locator":{"by":"role", "value":"button", "exact":"true"}}),
        json!({"locator":{"by":"text", "value":"save", "invented":true}}),
        json!({"locator":{"by":"role", "value":"button", "name":null}}),
        json!({"target":"rpa-observed-0"}),
        json!({"x":1, "y":2}),
        json!({"includeScreenshot":true}),
    ] {
        let mut input = base.clone();
        input
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(BrowserInput::parse(input.clone()).is_err(), "{input}");
    }
    let schema = input::schema();
    assert!(schema["properties"].get("locator").is_some());
    assert!(schema["properties"].get("includeScreenshot").is_none());
    assert_eq!(
        schema["properties"]["locator"]["properties"]["exact"]["default"],
        true
    );
    assert_eq!(
        schema["properties"]["locator"]["properties"]["value"]["minLength"],
        1
    );
}

#[test]
fn locator_serialization_does_not_turn_an_omitted_name_into_a_filter() {
    let input = BrowserInput::parse(json!({
        "action":"click", "observationId":"observed",
        "locator":{"by":"text", "value":"保存"}
    }))
    .unwrap();
    let encoded = serde_json::to_value(input).unwrap();
    assert_eq!(
        encoded["locator"],
        json!({"by":"text", "value":"保存", "exact":true})
    );
    for input in [
        json!({"action":"snapshot", "x":1}),
        json!({"action":"drag", "observationId":"observed", "locator":{"by":"css", "value":"#start"}, "endX":1}),
        json!({"action":"select", "observationId":"observed", "locator":{"by":"css", "value":"select"}, "values":[]}),
        json!({"action":"select", "observationId":"observed", "locator":{"by":"css", "value":"select"}, "values":vec!["a";101]}),
    ] {
        assert!(BrowserInput::parse(input).is_err());
    }
}

#[tokio::test]
async fn locator_actions_use_the_dom_driver_without_requesting_images() {
    let driver = Arc::new(MockDriver::default());
    let ctx = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    let mut observed = tool
        .execute(&ctx, json!({"action":"snapshot"}))
        .await
        .unwrap();
    for action in ["click", "doubleClick", "move", "scroll"] {
        observed = tool
            .execute(
                &ctx,
                json!({
                    "action":action, "observationId":observed["observationId"],
                    "locator":{"by":"role", "value":"button", "name":"保存"}
                }),
            )
            .await
            .unwrap();
        assert_eq!(observed["imageAttached"], false);
        assert!(tool.output_images(&ctx, &observed).is_empty());
    }
    for request in driver.requests() {
        assert!(request.arguments.get("includeScreenshot").is_none());
        assert_ne!(request.operation, "screenshot");
    }
}

#[test]
fn locator_capability_is_independent_of_screenshot_support() {
    let mut flags = capabilities();
    assert!(flags.element_locators);
    assert!(!flags.screenshot);
    flags.element_locators = false;
    let input = BrowserInput::parse(json!({
        "action":"click", "observationId":"observed",
        "locator":{"by":"text", "value":"保存"}
    }))
    .unwrap();
    assert!(!supports(&flags, &input));
}

#[test]
fn browser_pointer_actions_require_a_pointer_independent_of_the_desktop() {
    let mut flags = capabilities();
    for action in ["click", "doubleClick", "move", "drag", "scroll"] {
        let input = BrowserInput::parse(json!({
            "action":action, "observationId":"observed",
            "x":10, "y":20, "endX":30, "endY":40
        }))
        .unwrap();
        assert!(supports(&flags, &input), "{action}");
        flags.independent_pointer = false;
        assert!(!supports(&flags, &input), "{action}");
        flags.independent_pointer = true;
    }
}

#[tokio::test]
async fn refuses_locators_when_a_connected_driver_does_not_offer_them() {
    let driver = Arc::new(MockDriver {
        no_locators: true,
        ..Default::default()
    });
    let ctx = context(driver.clone());
    let tool = BrowserAutomationTool::default();
    let observed = tool
        .execute(&ctx, json!({"action":"snapshot"}))
        .await
        .unwrap();
    let error = tool
        .execute(
            &ctx,
            json!({
                "action":"click", "observationId":observed["observationId"],
                "locator":{"by":"text", "value":"保存"}
            }),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("does not support"));
    assert_eq!(driver.requests().len(), 1);
}
