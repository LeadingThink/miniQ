use super::*;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

struct FakeDesktop {
    inputs: AtomicUsize,
    focus: AtomicU32,
    denied: AtomicBool,
    captures: AtomicUsize,
    display_error: AtomicBool,
}

fn display() -> Display {
    Display {
        id: 1,
        name: "Test".into(),
        x: -1200,
        y: 100,
        width: 1200,
        height: 800,
        primary: true,
    }
}

impl DesktopBackend for FakeDesktop {
    fn permissions(&self) -> miniq_protocol::ComputerPermissions {
        miniq_protocol::ComputerPermissions {
            platform: "test".into(),
            process_id: 0,
            executable: "fake".into(),
            screen_recording: if self.denied.load(Ordering::SeqCst) {
                miniq_protocol::ComputerPermissionState::Denied
            } else {
                miniq_protocol::ComputerPermissionState::Granted
            },
            accessibility: miniq_protocol::ComputerPermissionState::Granted,
            display_server: None,
        }
    }
    fn displays(&self) -> Result<Vec<Display>, String> {
        if self.display_error.load(Ordering::SeqCst) {
            return Err("no display".into());
        }
        Ok(vec![display()])
    }
    fn capture(&self, _id: u32) -> Result<(Display, image::RgbaImage), String> {
        self.captures.fetch_add(1, Ordering::SeqCst);
        Ok((display(), image::RgbaImage::new(120, 80)))
    }
    fn focus(&self) -> Result<Option<FocusedWindow>, String> {
        Ok(Some(FocusedWindow {
            id: self.focus.load(Ordering::SeqCst),
            display_id: 1,
            x: -1200,
            y: 100,
            width: 1000,
            height: 700,
        }))
    }
    fn perform(
        &self,
        ctx: &ToolContext,
        _input: &ComputerInput,
        _display: &Display,
        _size: (u32, u32),
    ) -> Result<(), String> {
        observation::check_cancelled(ctx)?;
        self.inputs.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn retina_and_negative_monitor_origins_map_correctly() {
    assert_eq!(
        native::coordinates(&display(), (2400, 1600), Some(1200.), Some(800.)).unwrap(),
        (-600, 500)
    );
    for (x, y) in [
        (-1., 0.),
        (2400., 0.),
        (0., 1600.),
        (f64::NAN, 0.),
        (0., f64::INFINITY),
    ] {
        assert!(native::coordinates(&display(), (2400, 1600), Some(x), Some(y)).is_err());
    }
}

#[test]
fn keys_are_validated_before_pressing_modifiers() {
    for key in ["Enter", "Escape", "ArrowUp", "F12", "a", "中"] {
        assert!(native::parse_key(key).is_ok());
    }
    for key in ["", "Ctrl+A", "unknown"] {
        assert!(native::parse_key(key).is_err());
    }
}

#[test]
fn desktop_screenshots_are_private_high_risk() {
    let tool = ComputerUseTool::default();
    let ctx = ToolContext::new(std::env::temp_dir());
    for action in ["screenshot", "click", "key", "type", "wait"] {
        assert_eq!(
            tool.evaluate_risk(&ctx, &json!({"action":action})).level,
            RiskLevel::High
        );
    }
    for action in ["status", "release"] {
        assert_eq!(
            tool.evaluate_risk(&ctx, &json!({"action":action})).level,
            RiskLevel::Low
        );
    }
    assert!(ComputerInput::parse(json!({"action":"wait","milliseconds":5001})).is_err());
    assert!(ComputerInput::parse(json!({"action":"screenshot","invented":true})).is_err());
    assert!(
        ComputerInput::parse(json!({"action":"click","x":-1,"y":0,"observationId":"frame"}))
            .is_err()
    );
    assert!(ComputerInput::parse(json!({"action":"screenshot","displayId":null})).is_err());
    assert_eq!(input::schema()["properties"]["x"]["minimum"], 0.0);
    assert_eq!(
        input::schema()["properties"]["milliseconds"]["maximum"],
        5000.0
    );
}

#[tokio::test]
async fn desktop_lease_rejects_other_tasks_stale_frames_and_changed_focus() {
    let directory = tempfile::tempdir().unwrap();
    let first =
        ToolContext::new(directory.path().into()).with_observations(directory.path().into());
    let second = ToolContext::new(directory.path().into());
    let backend = Arc::new(FakeDesktop {
        inputs: AtomicUsize::new(0),
        focus: AtomicU32::new(1),
        denied: AtomicBool::new(false),
        captures: AtomicUsize::new(0),
        display_error: AtomicBool::new(false),
    });
    let tool = ComputerUseTool {
        lease: Arc::default(),
        backend: backend.clone(),
    };
    let first_frame = tool
        .execute(&first, json!({"action":"screenshot"}))
        .await
        .unwrap();
    let status = tool
        .execute(&second, json!({"action":"status"}))
        .await
        .unwrap();
    assert_eq!(status["inUse"], true);
    assert_eq!(status["ownedByTask"], false);
    assert!(status["leaseRemainingSeconds"].as_u64().unwrap() > 0);
    assert_eq!(backend.captures.load(Ordering::SeqCst), 1);
    assert_eq!(
        tool.lease.lock().unwrap().as_ref().unwrap().owner,
        first.task_scope
    );
    assert!(
        acquire_lock().is_err(),
        "a second process/handle must not acquire desktop input"
    );
    assert!(tool
        .execute(&second, json!({"action":"screenshot"}))
        .await
        .unwrap_err()
        .to_string()
        .contains("another task"));
    assert!(tool
        .execute(&second, json!({"action":"release"}))
        .await
        .is_err());
    let output = tool
        .execute(
            &first,
            json!({"action":"type","text":"hello","observationId":first_frame["observationId"]}),
        )
        .await
        .unwrap();
    assert_ne!(output["observationId"], first_frame["observationId"]);
    assert_eq!(backend.inputs.load(Ordering::SeqCst), 1);
    backend.focus.store(2, Ordering::SeqCst);
    assert!(tool
        .execute(
            &first,
            json!({"action":"key","key":"Enter","observationId":output["observationId"]})
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("foreground"));
    assert_eq!(backend.inputs.load(Ordering::SeqCst), 1);
    let output = tool
        .execute(&first, json!({"action":"screenshot"}))
        .await
        .unwrap();
    assert!(tool
        .execute(
            &first,
            json!({"action":"click","x":1,"y":1,"observationId":"old"})
        )
        .await
        .is_err());
    assert_eq!(backend.inputs.load(Ordering::SeqCst), 1);
    assert!(!output["screenshot"]["id"].as_str().unwrap().is_empty());
    tool.execute(&second, json!({"action":"screenshot"}))
        .await
        .unwrap();
    second.cancellation.cancel();
    tokio::time::timeout(Duration::from_secs(1), async {
        while tool.lease.lock().unwrap().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(tool.lease.lock().unwrap().is_none());
    assert!(acquire_lock().is_ok());
}

#[tokio::test]
async fn denied_permissions_prevent_capture_and_input_but_not_diagnostics() {
    let backend = Arc::new(FakeDesktop {
        inputs: AtomicUsize::new(0),
        focus: AtomicU32::new(1),
        denied: AtomicBool::new(true),
        captures: AtomicUsize::new(0),
        display_error: AtomicBool::new(true),
    });
    let tool = ComputerUseTool {
        lease: Arc::default(),
        backend: backend.clone(),
    };
    let ctx = ToolContext::new(std::env::temp_dir());
    let status = tool
        .execute(&ctx, json!({"action":"status"}))
        .await
        .unwrap();
    assert_eq!(status["permissions"]["screenRecording"], "denied");
    assert_eq!(status["displayError"], "no display");
    for input in [
        json!({"action":"screenshot"}),
        json!({"action":"key","key":"Enter","observationId":"old"}),
    ] {
        assert!(tool
            .execute(&ctx, input)
            .await
            .unwrap_err()
            .to_string()
            .contains("computer_permission_required"));
    }
    assert_eq!(backend.captures.load(Ordering::SeqCst), 0);
    assert_eq!(backend.inputs.load(Ordering::SeqCst), 0);
    assert!(tool.lease.lock().unwrap().is_none());
}
