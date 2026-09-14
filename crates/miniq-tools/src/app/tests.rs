use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Default)]
struct FakeState {
    actions: AtomicUsize,
    captures: AtomicUsize,
    invalid: AtomicBool,
    deny_ax: AtomicBool,
    deny_capture: AtomicBool,
    fail_action: AtomicBool,
    fail_capture: AtomicBool,
    close_after_action: AtomicBool,
    windows: Mutex<Vec<AppWindow>>,
}

struct FakeBackend(Arc<FakeState>);
struct FakeSnapshot(Arc<FakeState>);

fn target(pid: i32, window_id: u32) -> AppWindow {
    AppWindow {
        pid,
        window_id,
        process_instance: "123:456".into(),
        unavailable_reason: None,
        app_name: "Fixture".into(),
        title: "Draft".into(),
        x: -100,
        y: 0,
        width: 100,
        height: 80,
    }
}

impl AppBackend for FakeBackend {
    fn supported(&self) -> bool {
        true
    }
    fn permissions(&self) -> miniq_protocol::ComputerPermissions {
        miniq_protocol::ComputerPermissions {
            platform: "macos".into(),
            process_id: 1,
            executable: "fixture".into(),
            screen_recording: if self.0.deny_capture.load(Ordering::SeqCst) {
                ComputerPermissionState::Denied
            } else {
                ComputerPermissionState::Granted
            },
            accessibility: if self.0.deny_ax.load(Ordering::SeqCst) {
                ComputerPermissionState::Denied
            } else {
                ComputerPermissionState::Granted
            },
            display_server: None,
        }
    }
    fn windows(&self) -> Result<Vec<AppWindow>, String> {
        Ok(self.0.windows.lock().unwrap().clone())
    }
    fn snapshot(&self, _: &AppWindow) -> Result<Box<dyn AppSnapshot>, String> {
        let snapshot = FakeSnapshot(self.0.clone());
        snapshot.validate()?;
        Ok(Box::new(snapshot))
    }
    fn capture(&self, _: &AppWindow) -> Result<image::RgbaImage, String> {
        self.0.captures.fetch_add(1, Ordering::SeqCst);
        if self.0.fail_capture.load(Ordering::SeqCst) {
            return Err("capture unavailable".into());
        }
        Ok(image::RgbaImage::new(200, 160))
    }
}

impl AppSnapshot for FakeSnapshot {
    fn validate(&self) -> Result<(), String> {
        if self.0.invalid.load(Ordering::SeqCst) {
            Err("window closed".into())
        } else {
            Ok(())
        }
    }
    fn page(&mut self, _: Option<&str>, offset: usize, limit: usize) -> Result<Value, String> {
        let end = offset.saturating_add(limit).min(120);
        Ok(
            json!({"elements": (offset..end).map(|n| json!({"id":format!("e{n}")})).collect::<Vec<_>>(),
            "rootId":"root", "total":120,"nextOffset":(end<120).then_some(end)}),
        )
    }
    fn perform(
        &mut self,
        _: &ToolContext,
        _: &AppInput,
        _: Option<(u32, u32)>,
    ) -> Result<Value, String> {
        self.0.actions.fetch_add(1, Ordering::SeqCst);
        if self.0.close_after_action.load(Ordering::SeqCst) {
            self.0.invalid.store(true, Ordering::SeqCst);
        }
        if self.0.fail_action.load(Ordering::SeqCst) {
            Err("event delivery uncertain".into())
        } else {
            Ok(json!({"dispatched":true}))
        }
    }
}

fn setup() -> (
    tempfile::TempDir,
    AppAutomationTool,
    ToolContext,
    Arc<FakeState>,
) {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(FakeState::default());
    *state.windows.lock().unwrap() = vec![target(11, 1), target(12, 2)];
    let tool = AppAutomationTool {
        leases: Arc::default(),
        window_lists: Arc::default(),
        backend: Arc::new(FakeBackend(state.clone())),
        lock_root: directory.path().into(),
    };
    let ctx = ToolContext::new(directory.path().into())
        .with_observations(directory.path().join("observations"));
    (directory, tool, ctx, state)
}

async fn inspect(tool: &AppAutomationTool, ctx: &ToolContext) -> Value {
    tool.execute(ctx, json!({"action":"inspect","pid":11,"windowId":1}))
        .await
        .unwrap()
}

fn press(frame: &Value) -> Value {
    json!({"action":"invoke","axAction":"AXPress","pid":11,"windowId":1,"observationId":frame["observationId"],"elementId":"e0"})
}

#[test]
fn schema_and_runtime_require_observed_targets_and_bounded_pages() {
    for value in [
        json!({"action":"invoke","axAction":"AXPress","pid":11,"windowId":1,"elementId":"e0"}),
        json!({"action":"invoke","pid":11,"windowId":1,"observationId":"id","elementId":"e0"}),
        json!({"action":"invoke","axAction":"AXRaise","pid":11,"windowId":1,"observationId":"id","elementId":"e0"}),
        json!({"action":"setValue","pid":11,"windowId":1,"observationId":"id","elementId":"e0","text":"old parameter"}),
        json!({"action":"setValue","pid":11,"windowId":1,"observationId":"id","elementId":"e0","value":[1]}),
        json!({"action":"setValue","pid":11,"windowId":1,"observationId":"id","elementId":"e0","value":{"number":1,"text":"ambiguous"}}),
        json!({"action":"inspect","pid":0,"windowId":1}),
        json!({"action":"inspect","pid":11,"windowId":1,"parentId":"e0"}),
        json!({"action":"screenshot","pid":11,"windowId":1,"offset":1}),
        json!({"action":"windows","offset":1}),
        json!({"action":"windows","limit":101}),
        json!({"action":"windows","limit":0}),
        json!({"action":"windows","pid":null}),
        json!({"action":"status","key":"invalid"}),
        json!({"action":"status","scrollY":-2147483648_i64}),
        json!({"action":"inspect","pid":11,"windowId":1,"observationId":""}),
        json!({"action":"inspect","pid":11,"windowId":1,"invented":true}),
        json!({"action":"key","pid":11,"windowId":1,"observationId":"id","key":"F01"}),
    ] {
        assert!(AppInput::parse(value.clone()).is_err(), "accepted {value}");
    }
    assert_eq!(input::schema()["properties"]["pid"]["minimum"], 1.0);
    assert_eq!(input::schema()["properties"]["limit"]["maximum"], 100.0);
    assert_eq!(
        input::schema()["properties"]["observationId"]["minLength"],
        1
    );
    assert!(input::schema()["properties"]["key"]["pattern"].is_string());
    assert_eq!(
        input::schema()["properties"]["axAction"]["not"],
        json!({"const":"AXRaise"})
    );
    assert_eq!(
        input::schema()["allOf"][0]["then"]["required"],
        json!(["observationId"])
    );
    assert!(crate::default_router().get("app_automation").is_some());
}

#[tokio::test]
async fn ax_only_operations_need_no_screen_recording_and_preserve_full_pages() {
    let (_directory, tool, ctx, state) = setup();
    state.deny_capture.store(true, Ordering::SeqCst);
    let first = inspect(&tool, &ctx).await;
    assert_eq!(first["elements"].as_array().unwrap().len(), 40);
    let second = tool.execute(&ctx, json!({"action":"inspect","pid":11,"windowId":1,"observationId":first["observationId"],"offset":40,"limit":100})).await.unwrap();
    assert_eq!(second["elements"].as_array().unwrap().len(), 80);
    assert_eq!(second["elements"][79]["id"], "e119");
    assert!(second["nextOffset"].is_null());
    let result = tool.execute(&ctx, press(&first)).await.unwrap();
    assert_eq!(result["actionDispatched"], true);
    assert_ne!(first["observationId"], result["observationId"]);
    assert_eq!(state.captures.load(Ordering::SeqCst), 0);
    assert!(tool
        .execute(&ctx, json!({"action":"screenshot","pid":11,"windowId":1}))
        .await
        .is_err());
    assert!(tool.execute(&ctx, press(&first)).await.is_err());
    assert_eq!(state.actions.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn windows_pages_are_frozen_and_scoped_to_the_requesting_task() {
    let (_directory, tool, ctx, state) = setup();
    let first = tool
        .execute(&ctx, json!({"action":"windows","limit":1}))
        .await
        .unwrap();
    state.windows.lock().unwrap().clear();
    let next =
        json!({"action":"windows","limit":1,"offset":1,"observationId":first["observationId"]});
    let second = tool.execute(&ctx, next.clone()).await.unwrap();
    assert_eq!(second["windows"][0]["pid"], 12);
    assert!(second["nextOffset"].is_null());
    let other = ToolContext::new(ctx.workspace.clone());
    assert!(tool.execute(&other, next).await.is_err());
}

#[tokio::test]
async fn unavailable_windows_remain_visible_but_cannot_be_authorized_or_controlled() {
    let (_directory, tool, ctx, state) = setup();
    state.windows.lock().unwrap()[0].unavailable_reason =
        Some("system process identity unavailable".into());
    let list = tool
        .execute(&ctx, json!({"action":"windows"}))
        .await
        .unwrap();
    assert_eq!(list["total"], 2);
    assert!(list["windows"][0]["unavailableReason"].is_string());
    let input = json!({"action":"inspect","pid":11,"windowId":1});
    assert!(tool.approval_scope(&ctx, &input).is_none());
    assert!(tool
        .execute(&ctx, input)
        .await
        .unwrap_err()
        .to_string()
        .contains("background_target_unavailable"));
    tool.execute(&ctx, json!({"action":"inspect","pid":12,"windowId":2}))
        .await
        .unwrap();
    assert_eq!(state.actions.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn denied_ax_and_cancelled_tasks_do_not_send_input() {
    let (_directory, tool, ctx, state) = setup();
    state.deny_ax.store(true, Ordering::SeqCst);
    assert_eq!(
        tool.execute(&ctx, json!({"action":"status"}))
            .await
            .unwrap()["permissions"]["accessibility"],
        "denied"
    );
    assert!(tool
        .execute(&ctx, json!({"action":"inspect","pid":11,"windowId":1}))
        .await
        .is_err());
    state.deny_ax.store(false, Ordering::SeqCst);
    let frame = inspect(&tool, &ctx).await;
    ctx.cancellation.cancel();
    assert!(tool.execute(&ctx, press(&frame)).await.is_err());
    assert_eq!(state.actions.load(Ordering::SeqCst), 0);
    tokio::time::timeout(Duration::from_secs(1), async {
        while !tool.leases.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn leases_isolate_apps_tasks_windows_and_foreground_takeover() {
    let (directory, tool, first, _state) = setup();
    let second = ToolContext::new(directory.path().into());
    let frame = inspect(&tool, &first).await;
    assert!(tool
        .execute(&second, press(&frame))
        .await
        .unwrap_err()
        .to_string()
        .contains("another task"));
    assert!(tool
        .execute(&second, json!({"action":"release","pid":11,"windowId":1}))
        .await
        .is_err());
    tool.execute(&second, json!({"action":"inspect","pid":12,"windowId":2}))
        .await
        .unwrap();
    assert!(crate::desktop_lock::foreground(directory.path()).is_err());
    let mut wrong = press(&frame);
    wrong["windowId"] = json!(2);
    assert!(tool.execute(&first, wrong).await.is_err());
    tool.execute(&first, json!({"action":"release","pid":11,"windowId":1}))
        .await
        .unwrap();
    tool.execute(&second, json!({"action":"release","pid":12,"windowId":2}))
        .await
        .unwrap();
    assert!(crate::desktop_lock::foreground(directory.path()).is_ok());
}

#[tokio::test]
async fn independent_tool_instances_cannot_operate_the_same_app() {
    let (directory, first_tool, ctx, state) = setup();
    let second_tool = AppAutomationTool {
        leases: Arc::default(),
        window_lists: Arc::default(),
        backend: Arc::new(FakeBackend(state)),
        lock_root: directory.path().into(),
    };
    inspect(&first_tool, &ctx).await;
    assert!(second_tool
        .execute(&ctx, json!({"action":"inspect","pid":11,"windowId":1}))
        .await
        .is_err());
    second_tool
        .execute(&ctx, json!({"action":"inspect","pid":12,"windowId":2}))
        .await
        .unwrap();
}

#[tokio::test]
async fn observation_failures_preserve_completed_actions_without_replay() {
    for close_window in [false, true] {
        let (_directory, tool, ctx, state) = setup();
        let frame = inspect(&tool, &ctx).await;
        state
            .close_after_action
            .store(close_window, Ordering::SeqCst);
        state.fail_capture.store(true, Ordering::SeqCst);
        let mut input = press(&frame);
        input["includeScreenshot"] = json!(true);
        let result = tool.execute(&ctx, input).await.unwrap();
        assert_eq!(result["actionDispatched"], true);
        assert!(result["observationError"].is_string());
        assert!(result.get("observationId").is_none());
        assert!(tool.execute(&ctx, press(&frame)).await.is_err());
        assert_eq!(state.actions.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn uncertain_input_errors_also_consume_the_observation() {
    let (_directory, tool, ctx, state) = setup();
    let frame = inspect(&tool, &ctx).await;
    state.fail_action.store(true, Ordering::SeqCst);
    assert!(tool
        .execute(&ctx, press(&frame))
        .await
        .unwrap_err()
        .to_string()
        .contains("partially applied"));
    assert!(tool
        .execute(&ctx, press(&frame))
        .await
        .unwrap_err()
        .to_string()
        .contains("stale"));
    assert_eq!(state.actions.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn authorization_is_target_and_process_specific_not_title_or_observation_wide() {
    let (_directory, tool, ctx, state) = setup();
    let frame = inspect(&tool, &ctx).await;
    let control = tool.approval_scope(&ctx, &press(&frame)).unwrap();
    let read = tool
        .approval_scope(&ctx, &json!({"action":"inspect","pid":11,"windowId":1}))
        .unwrap();
    assert_ne!(control, read);
    state.windows.lock().unwrap()[0].title = "Revised subject".into();
    assert_eq!(tool.approval_scope(&ctx, &press(&frame)), Some(control));
    state.windows.lock().unwrap()[0].process_instance = "999:123".into();
    assert!(tool.approval_scope(&ctx, &press(&frame)).is_none());
    let new_read = tool
        .approval_scope(&ctx, &json!({"action":"inspect","pid":11,"windowId":1}))
        .unwrap();
    assert_ne!(read, new_read);
}

#[tokio::test]
async fn coordinate_input_requires_an_image_and_images_are_attached_to_model_output() {
    let (_directory, tool, ctx, state) = setup();
    let frame = inspect(&tool, &ctx).await;
    let click = |frame: &Value| json!({"action":"click","pid":11,"windowId":1,"observationId":frame["observationId"],"x":10,"y":20});
    assert!(tool.execute(&ctx, click(&frame)).await.is_err());
    let frame = tool
        .execute(&ctx, json!({"action":"screenshot","pid":11,"windowId":1}))
        .await
        .unwrap();
    let images = tool.output_images(&ctx, &frame);
    assert_eq!(images.len(), 1);
    assert!(std::path::Path::new(&images[0].path).is_file());
    tool.execute(&ctx, click(&frame)).await.unwrap();
    assert_eq!(state.actions.load(Ordering::SeqCst), 1);
}
