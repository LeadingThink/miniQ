use super::*;

#[tokio::test]
async fn background_cohort_exceeds_old_count_limits_and_preserves_each_result() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let bridge = bridge_with_provider(&directory, provider.clone());
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
