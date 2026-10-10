use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use miniq_protocol::{Role, SessionDiff, ToolCallStatus};
use serde_json::json;

use super::*;
use crate::executor::checkpoint::file_state;

struct Fixture {
    state: AppState,
    session_id: String,
    workspace: tempfile::TempDir,
    backups: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let workspace = tempfile::tempdir().unwrap();
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let ws = store
            .create_workspace(workspace.path().to_str().unwrap(), "ws")
            .unwrap();
        let session = store.create_session(&ws.id, "s").unwrap();
        let state = AppState::new(
            store,
            "test".into(),
            Arc::new(miniq_models::mock::MockProvider::text("unused")),
        );
        Self {
            state,
            session_id: session.id,
            workspace,
            backups: tempfile::tempdir().unwrap(),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.workspace.path().join(name)
    }

    fn user_turn(&self, text: &str) -> String {
        // Distinct timestamps keep turn boundaries unambiguous.
        std::thread::sleep(std::time::Duration::from_millis(2));
        self.state
            .store
            .append_message(&self.session_id, Role::User, text)
            .unwrap()
            .id
    }

    /// Mirror the executor: checkpoint, write, record the after state.
    fn agent_write(&self, name: &str, content: &str) {
        let target = self.path(name);
        let call = self
            .state
            .store
            .create_tool_call(
                &self.session_id,
                "file_write",
                &json!({"path": name}),
                None,
                ToolCallStatus::Running,
            )
            .unwrap();
        let existed = target.is_file();
        let backup = existed.then(|| {
            let backup = self.backups.path().join(miniq_memory::new_id("bk"));
            fs::copy(&target, &backup).unwrap();
            backup.to_string_lossy().into_owned()
        });
        let checkpoint = self
            .state
            .store
            .create_checkpoint(
                &self.session_id,
                &call.id,
                &target.to_string_lossy(),
                existed,
                backup.as_deref(),
            )
            .unwrap();
        fs::write(&target, content).unwrap();
        self.state
            .store
            .set_checkpoint_after_state(&checkpoint.id, &file_state(&target).unwrap())
            .unwrap();
    }

    fn diff(&self, params: serde_json::Value) -> SessionDiff {
        let mut params = params;
        params["sessionId"] = json!(self.session_id);
        serde_json::from_value(super::super::session_diff::get(&self.state, Some(params)).unwrap())
            .unwrap()
    }

    fn revert(&self, turn_id: &str, force: bool) -> serde_json::Value {
        revert(
            &self.state,
            Some(json!({"sessionId": self.session_id, "turnId": turn_id, "force": force})),
        )
        .unwrap()
    }
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

#[test]
fn turn_diff_compares_turn_start_with_turn_end() {
    let fx = Fixture::new();
    fs::write(fx.path("a.txt"), "one\n").unwrap();
    let first = fx.user_turn("first");
    fx.agent_write("a.txt", "two\n");
    fx.agent_write("a.txt", "two\nextra\n");
    fx.agent_write("b.txt", "new\n");
    let second = fx.user_turn("second");
    fx.agent_write("a.txt", "three\n");

    let turn = fx.diff(json!({"scope": "turn", "turnId": first}));
    let paths: Vec<_> = turn.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(paths, ["a.txt", "b.txt"]);
    assert_eq!((turn.files[0].additions, turn.files[0].deletions), (2, 1));
    assert!(turn.files[0].hunks[0]
        .lines
        .iter()
        .any(|line| line.content == "extra"));
    assert!(!turn.files[1].old_exists);
    assert_eq!((turn.additions, turn.deletions), (3, 1));

    let latest = fx.diff(json!({"scope": "turn", "turnId": second}));
    assert_eq!(latest.files.len(), 1);
    assert_eq!((latest.additions, latest.deletions), (1, 2));

    let session = fx.diff(json!({}));
    assert_eq!(session.files.len(), 2);
    assert_eq!(
        (session.files[0].additions, session.files[0].deletions),
        (1, 1)
    );
}

#[test]
fn turn_diff_requires_a_turn_id() {
    let fx = Fixture::new();
    let error = super::super::session_diff::get(
        &fx.state,
        Some(json!({"sessionId": fx.session_id, "scope": "turn"})),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidParams as i64);
}

#[test]
fn revert_restores_every_file_to_turn_start() {
    let fx = Fixture::new();
    fs::write(fx.path("a.txt"), "one\n").unwrap();
    let turn = fx.user_turn("edit");
    fx.agent_write("a.txt", "two\n");
    fx.agent_write("a.txt", "three\n");
    fx.agent_write("b.txt", "created\n");

    let result = fx.revert(&turn, false);

    assert_eq!(result["reverted"], json!(true));
    assert_eq!(result["restoredFiles"].as_array().unwrap().len(), 2);
    assert_eq!(read(&fx.path("a.txt")), "one\n");
    assert!(!fx.path("b.txt").exists());
    assert!(fx
        .diff(json!({"scope": "turn", "turnId": turn}))
        .files
        .is_empty());
}

#[test]
fn revert_refuses_files_modified_after_the_turn_unless_forced() {
    let fx = Fixture::new();
    fs::write(fx.path("a.txt"), "one\n").unwrap();
    let first = fx.user_turn("first");
    fx.agent_write("a.txt", "two\n");
    fx.agent_write("b.txt", "created\n");
    fs::write(fx.path("a.txt"), "edited by user\n").unwrap();

    let refused = fx.revert(&first, false);

    assert_eq!(refused["reverted"], json!(false));
    let modified = refused["modifiedFiles"].as_array().unwrap();
    assert_eq!(modified.len(), 1);
    assert_eq!(modified[0]["path"], json!("a.txt"));
    assert_eq!(modified[0]["reason"], json!("modified"));
    // Validation happens before any write: nothing was restored.
    assert_eq!(read(&fx.path("a.txt")), "edited by user\n");
    assert!(fx.path("b.txt").exists());

    let forced = fx.revert(&first, true);
    assert_eq!(forced["reverted"], json!(true));
    assert_eq!(forced["forced"], json!(true));
    assert_eq!(read(&fx.path("a.txt")), "one\n");
    assert!(!fx.path("b.txt").exists());
}

#[test]
fn revert_detects_edits_from_a_later_turn() {
    let fx = Fixture::new();
    fs::write(fx.path("a.txt"), "one\n").unwrap();
    let first = fx.user_turn("first");
    fx.agent_write("a.txt", "two\n");
    fx.user_turn("second");
    fx.agent_write("a.txt", "three\n");

    let refused = fx.revert(&first, false);

    assert_eq!(refused["reverted"], json!(false));
    assert_eq!(read(&fx.path("a.txt")), "three\n");
}

#[test]
fn revert_is_rejected_while_the_session_is_running() {
    let fx = Fixture::new();
    let turn = fx.user_turn("edit");
    let _cancel = fx.state.begin_turn(&fx.session_id).unwrap();
    let error = revert(
        &fx.state,
        Some(json!({"sessionId": fx.session_id, "turnId": turn})),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::SessionBusy as i64);
}
