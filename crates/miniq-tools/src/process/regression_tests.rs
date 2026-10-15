use super::*;
use crate::{AgentResultTool, ShellBatchTool};

#[tokio::test]
async fn ordinary_shell_output_is_serialized_once_without_base64() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(dir.path().into());
    let marker = "unique-model-output-0123456789";
    let output = ShellRunTool
        .execute(&ctx, json!({"command":format!("echo {marker}")}))
        .await
        .unwrap();
    assert!(output["stdoutPage"].get("text").is_none());
    assert!(output["stdoutPage"].get("base64").is_none());
    assert!(output["stderrPage"].get("text").is_none());
    // Exclude the command echo in metadata: tool content has just one copy.
    let mut model = output.clone();
    model.as_object_mut().unwrap().remove("command");
    assert_eq!(model.to_string().matches(marker).count(), 1);
    let raw = ProcessOutputTool
        .execute(
            &ctx,
            json!({"id":output["shellId"],"stdoutOffset":0,"stderrOffset":0,"raw":true}),
        )
        .await
        .unwrap();
    assert!(raw["stdout"].is_null());
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(raw["stdoutPage"]["base64"].as_str().unwrap())
            .unwrap(),
        output["stdout"].as_str().unwrap().as_bytes()
    );
}
#[tokio::test]
async fn next_page_instruction_recovers_every_byte_and_batch_retains_it() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(dir.path().into());
    let first = ShellBatchTool
        .execute(
            &ctx,
            json!({"commands":["echo abcdefghijklmnopqrstuvwxyz"],"maxOutputLength":4}),
        )
        .await
        .unwrap();
    let mut output = first["output"][0].clone();
    assert!(output["outputNotice"]
        .as_str()
        .unwrap()
        .contains("PARTIAL OUTPUT"));
    let mut text = output["stdout"].as_str().unwrap().to_owned();
    while output["hasMore"] == true {
        output = ProcessOutputTool
            .execute(&ctx, output["nextPage"]["arguments"].clone())
            .await
            .unwrap();
        text.push_str(output["stdout"].as_str().unwrap());
    }
    assert_eq!(text.trim(), "abcdefghijklmnopqrstuvwxyz");
}
#[tokio::test]
async fn process_and_agent_contracts_do_not_accept_each_others_parameters() {
    let ctx = ToolContext::new(std::env::temp_dir());
    let error = ProcessOutputTool
        .execute(&ctx, json!({"id":"agent_test","maxOutputTokens":4500}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("agent_result"));
    assert!(AgentResultTool
        .execute(&ctx, json!({"id":"agent_test","maxOutputTokens":4500}))
        .await
        .is_err());
    assert!(AgentResultTool
        .execute(&ctx, json!({"id":"shell_test"}))
        .await
        .is_err());
    assert!(AgentResultTool.parameters_schema()["properties"]
        .get("maxOutputTokens")
        .is_none());
    assert_eq!(
        ProcessOutputTool.parameters_schema()["properties"]["id"]["pattern"],
        "^shell_"
    );
}
