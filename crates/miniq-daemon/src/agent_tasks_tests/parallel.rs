use super::*;

#[tokio::test]
async fn background_cohort_exceeds_old_count_limits_and_preserves_each_result() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let bridge = bridge_with_provider(&directory, provider.clone());
    bridge
        .state
        .settings
        .lock()
        .unwrap()
        .agent_preferences
        .max_subagents = 12;
    let mut ids = Vec::new();
    const COUNT: usize = 10;
    for index in 0..COUNT {
        let mut input = request(&format!(
            "Review resume-{index} with the same rubric; return its ID and all evidence"
        ));
        input.name = Some(format!("resume-{index}"));
        input.run_in_background = true;
        let running = bridge.run(input).await.unwrap();
        assert_eq!(running["status"], "running");
        ids.push(running["agentId"].as_str().unwrap().to_owned());
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if provider.requests.lock().await.len() == COUNT {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("every child must start while the others are still blocked");
    assert!(provider.requests.lock().await.iter().all(|request| {
        request.messages.iter().any(|message| {
            message.role == miniq_models::ChatRole::System
                && message
                    .content
                    .starts_with(crate::parallel_policy::PARALLEL_POLICY)
                && message.content.contains("there is no target worker count")
                && message
                    .content
                    .contains("configured maximum active subagent count")
        })
    }));
    provider.gate.add_permits(COUNT);
    let mut results = Vec::new();
    for id in &ids {
        let output = bridge
            .output(id, true, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(output["status"], "completed");
        assert_eq!(output["agentId"], *id);
        results.push(output["result"].as_str().unwrap().to_owned());
    }
    results.sort();
    let mut expected = (1..=COUNT)
        .map(|n| format!("result {n}"))
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(results, expected);
}

#[tokio::test]
async fn active_subagents_respect_the_configured_session_limit() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let bridge = bridge_with_provider(&directory, provider.clone());
    bridge
        .state
        .settings
        .lock()
        .unwrap()
        .agent_preferences
        .max_subagents = 2;

    for index in 0..2 {
        let mut input = request(&format!("parallel-{index}"));
        input.name = Some(format!("parallel-{index}"));
        input.run_in_background = true;
        assert_eq!(bridge.run(input).await.unwrap()["status"], "running");
    }
    let mut rejected = request("one too many");
    rejected.name = Some("rejected".into());
    rejected.run_in_background = true;
    let error = bridge.run(rejected).await.unwrap_err().to_string();
    assert!(error.contains("subagent limit reached (2)"), "{error}");

    provider.gate.add_permits(2);
}

#[tokio::test]
async fn resumed_subagents_respect_the_configured_session_limit() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let bridge = bridge_with_provider(&directory, provider.clone());
    bridge
        .state
        .settings
        .lock()
        .unwrap()
        .agent_preferences
        .max_subagents = 1;

    let mut first = request("completed");
    first.name = Some("completed-agent".into());
    first.run_in_background = true;
    let completed = bridge.run(first).await.unwrap();
    let completed_id = completed["agentId"].as_str().unwrap();
    provider.gate.add_permits(1);
    bridge
        .output(completed_id, true, Duration::from_secs(5))
        .await
        .unwrap();

    let mut occupying = request("occupying");
    occupying.name = Some("occupying-agent".into());
    occupying.run_in_background = true;
    bridge.run(occupying).await.unwrap();

    let mut resumed = request("resume");
    resumed.resume = Some(completed_id.to_owned());
    resumed.name = None;
    let error = bridge.run(resumed).await.unwrap_err();
    assert!(error.to_string().contains("subagent limit reached (1)"));

    provider.gate.add_permits(1);
}
