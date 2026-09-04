use super::*;
use miniq_models::{
    mock::MockProvider, ChatDelta, CompletionRequest, DeltaStream, ModelProvider, ProviderError,
};
use tokio::sync::{Mutex, Semaphore};

fn request(prompt: &str) -> AgentRunRequest {
    AgentRunRequest {
        prompt: prompt.into(),
        description: Some("test child".into()),
        subagent_type: Some("Explore".into()),
        model: None,
        resume: None,
        run_in_background: false,
        max_turns: Some(4),
        name: Some("researcher".into()),
        mode: None,
        cwd: None,
        isolation: None,
    }
}

fn bridge_with_provider(
    directory: &tempfile::TempDir,
    provider: Arc<dyn ModelProvider>,
) -> DaemonAgentBridge {
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "workspace")
        .unwrap();
    let session = store.create_session(&workspace.id, "agent test").unwrap();
    DaemonAgentBridge {
        state: AppState::new(store, "token".into(), provider),
        session_id: session.id,
        workspace: directory.path().to_path_buf(),
        workspace_id: workspace.id,
        depth: 0,
    }
}

struct GatedProvider {
    gate: Semaphore,
    requests: Mutex<Vec<CompletionRequest>>,
}

impl GatedProvider {
    fn new() -> Self {
        Self {
            gate: Semaphore::new(0),
            requests: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl ModelProvider for GatedProvider {
    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        let mut requests = self.requests.lock().await;
        requests.push(request);
        let call = requests.len();
        drop(requests);
        self.gate.acquire().await.unwrap().forget();
        Ok(Box::pin(futures_util::stream::iter([
            Ok(ChatDelta::Text(format!("result {call}"))),
            Ok(ChatDelta::Finished),
        ])))
    }

    fn describe(&self) -> String {
        "gated test provider".into()
    }
}

#[tokio::test]
async fn foreground_agent_completes_and_resumes_with_preserved_history() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::new(vec![
        vec![ChatDelta::Text("first result".into())],
        vec![ChatDelta::Text("second result".into())],
    ]));
    let bridge = bridge_with_provider(&directory, provider.clone());

    let first = bridge.run(request("inspect")).await.unwrap();
    assert_eq!(first["status"], "completed");
    assert_eq!(first["result"], "first result");
    let id = first["agentId"].as_str().unwrap().to_string();

    let mut resumed = request("continue");
    resumed.resume = Some(id);
    resumed.name = None;
    let second = bridge.run(resumed).await.unwrap();
    assert_eq!(second["status"], "completed");
    assert_eq!(second["result"], "second result");

    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1]
        .messages
        .iter()
        .any(|message| message.content == "first result"));
    assert_eq!(requests[1].messages.last().unwrap().content, "continue");
}

#[tokio::test]
async fn message_to_completed_agent_resumes_in_background_with_original_model() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::new(vec![
        vec![ChatDelta::Text("first result".into())],
        vec![ChatDelta::Text("follow-up result".into())],
    ]));
    let bridge = bridge_with_provider(&directory, provider.clone());
    let mut initial = request("inspect");
    initial.model = Some("claude-sonnet-4.6".into());
    let first = bridge.run(initial).await.unwrap();
    let id = first["agentId"].as_str().unwrap();

    let resumed = bridge
        .send(AgentMessageRequest {
            recipient: id.into(),
            message: "check once more".into(),
            summary: Some("follow up".into()),
        })
        .await
        .unwrap();
    assert_eq!(resumed["status"], "running");
    assert_eq!(resumed["model"], "claude-sonnet-4.6");

    let completed = bridge
        .output(id, true, Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["result"], "follow-up result");
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].messages.last().unwrap().content,
        "check once more"
    );
}

#[tokio::test]
async fn running_agent_processes_queued_message_as_a_follow_up_turn() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let bridge = bridge_with_provider(&directory, provider.clone());
    let mut background = request("first prompt");
    background.run_in_background = true;
    let started = bridge.run(background).await.unwrap();
    let id = started["agentId"].as_str().unwrap();

    let queued = bridge
        .send(AgentMessageRequest {
            recipient: id.into(),
            message: "queued follow up".into(),
            summary: None,
        })
        .await
        .unwrap();
    assert_eq!(queued["status"], "queued");
    provider.gate.add_permits(2);

    let completed = bridge
        .output(id, true, Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["result"], "result 2");
    let requests = provider.requests.lock().await;
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].messages.last().unwrap().content,
        "queued follow up"
    );
}

#[tokio::test]
async fn background_agent_can_be_stopped_while_waiting_for_the_provider() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let bridge = bridge_with_provider(&directory, provider.clone());
    let mut background = request("wait");
    background.run_in_background = true;
    let started = bridge.run(background).await.unwrap();
    let id = started["agentId"].as_str().unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if !provider.requests.lock().await.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let stopped = bridge.stop(id).await.unwrap();
    assert_eq!(stopped["status"], "cancelled");
    assert_eq!(stopped["error"], "agent stopped by caller");

    let resumed = bridge
        .send(AgentMessageRequest {
            recipient: id.into(),
            message: "resume after stop".into(),
            summary: None,
        })
        .await
        .unwrap();
    assert_eq!(resumed["status"], "running");
    provider.gate.add_permits(1);
    let completed = bridge
        .output(id, true, Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["result"], "result 2");
}
