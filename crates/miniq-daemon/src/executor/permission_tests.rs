use super::*;
use crate::state::{ApprovalDecision, ApprovalMode};

#[tokio::test]
async fn child_policies_cannot_bypass_a_sessions_always_ask_mode() {
    for policy in [
        PermissionPolicy::Inherit,
        PermissionPolicy::AcceptEdits,
        PermissionPolicy::DontAsk,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let workspace = store
            .create_workspace(directory.path().to_str().unwrap(), "test")
            .unwrap();
        let session = store.create_session(&workspace.id, "ask").unwrap();
        store
            .set_session_approval_mode(&session.id, Some(ApprovalMode::AlwaysAsk))
            .unwrap();
        let state = AppState::new(
            store,
            "test".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::text("unused")),
        );
        state.settings.lock().unwrap().approval_mode = ApprovalMode::FullAccess;
        state.allow_for_session(&session.id, "file_write");
        let mut events = state.events.subscribe();
        let executor = SessionToolExecutor {
            state: state.clone(),
            session_id: session.id,
            router: state.router.clone(),
            ctx: ToolContext::new(directory.path().into()),
            cancel: CancellationToken::new(),
            permission_policy: policy,
            review_plan: Default::default(),
        };
        let task = tokio::spawn(async move {
            executor
                .execute(&ToolCallRequest {
                    id: "unapproved-write".into(),
                    name: "file_write".into(),
                    arguments: json!({"path":"denied.txt","content":"must not write"}),
                })
                .await
        });
        if policy != PermissionPolicy::DontAsk {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    if let Event::ApprovalRequested { approval, .. } = events.recv().await.unwrap()
                    {
                        assert!(!directory.path().join("denied.txt").exists());
                        assert!(state.deliver_approval(&approval.id, ApprovalDecision::Reject));
                        break;
                    }
                }
            })
            .await
            .unwrap();
        }
        let result = task.await.unwrap().unwrap();
        assert_eq!(result["rejected"], true);
        assert!(!directory.path().join("denied.txt").exists());
    }
}
