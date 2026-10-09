use super::*;

#[tokio::test]
async fn explicit_model_saves_without_claiming_validation_or_exposing_key() {
    let fixture = Fixture::new("unconfigured").await;
    let result = fixture
        .run_with_key(
            &["configure", "--model", "custom-model"],
            "",
            Some("fixture-secret"),
        )
        .await;
    assert!(result.status.success());
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(output.contains("Configuration saved."));
    assert!(output.contains("model catalog was not requested"));
    assert!(output.contains("No model reply has been tested."));
    assert!(!output.contains("Connected."));
    assert!(!output.contains("fixture-secret"));
    let requests = methods(&fixture);
    assert!(requests.iter().all(|request| matches!(
        request["method"].as_str(),
        Some("daemon.health" | "settings.get" | "settings.update")
    )));
    let update = requests
        .iter()
        .find(|request| request["method"] == "settings.update")
        .unwrap();
    assert_eq!(update["params"]["provider"]["model"], "custom-model");
}

#[tokio::test]
async fn noninteractive_configuration_requires_key_and_endpoint_specific_model() {
    for (mode, args, key, message) in [
        (
            "unconfigured",
            vec!["configure", "--model", "fixture"],
            None,
            "Configuration needs a terminal or MINIQ_API_KEY",
        ),
        (
            "unconfigured",
            vec!["configure"],
            Some("fixture-secret"),
            "Pass --model MODEL",
        ),
        (
            "success",
            vec!["configure", "--base-url", "https://other.test/v1"],
            Some("fixture-secret"),
            "Pass --model MODEL",
        ),
        (
            "unconfigured",
            vec!["configure", "--model", "fixture"],
            Some(""),
            "API Key is empty",
        ),
        (
            "success",
            vec!["configure", "--model", " "],
            Some("fixture-secret"),
            "model must not be empty",
        ),
    ] {
        let fixture = Fixture::new(mode).await;
        let result = fixture.run_with_key(&args, "", key).await;
        assert!(!result.status.success(), "{args:?}");
        assert!(String::from_utf8_lossy(&result.stderr).contains(message));
        assert!(methods(&fixture).iter().all(|request| matches!(
            request["method"].as_str(),
            Some("daemon.health" | "settings.get")
        )));
    }
}

#[tokio::test]
async fn noninteractive_key_rotation_keeps_saved_model_and_protocol() {
    let fixture = Fixture::new("success").await;
    let result = fixture
        .run_with_key(&["configure"], "", Some("fixture-secret"))
        .await;
    assert!(result.status.success());
    let requests = methods(&fixture);
    let update = requests
        .iter()
        .find(|request| request["method"] == "settings.update")
        .unwrap();
    assert_eq!(update["params"]["provider"]["model"], "fixture");
    assert_eq!(update["params"]["provider"]["apiProtocol"], "responses");
    assert!(!requests
        .iter()
        .any(|request| request["method"] == "settings.models"));
}
