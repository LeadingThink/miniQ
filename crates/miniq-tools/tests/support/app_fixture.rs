//! Owns only the synthetic Cocoa processes and their temporary artifacts.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub(super) struct Fixture {
    pub(super) directory: tempfile::TempDir,
    binary: PathBuf,
    processes: Vec<Child>,
    pub(super) target: Value,
    foreground_pid: u32,
    pub(super) page_limit: usize,
    events: bool,
}

impl Fixture {
    pub(super) fn launch() -> Self {
        Self::launch_mode(false)
    }

    pub(super) fn launch_events() -> Self {
        Self::launch_mode(true)
    }

    fn launch_mode(events: bool) -> Self {
        let directory = tempfile::Builder::new()
            .prefix("miniq-app-fixture-")
            .tempdir_in("/tmp")
            .expect("fixture temp directory");
        let binary = directory.path().join("miniq-app-fixture");
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/app_automation_fixture.swift");
        let output = Command::new("xcrun")
            .arg("swiftc")
            .arg(source)
            .arg("-o")
            .arg(&binary)
            .output()
            .expect("Xcode Command Line Tools with swiftc are required");
        assert!(
            output.status.success(),
            "Swift fixture failed to compile: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut fixture = Self {
            directory,
            binary,
            processes: Vec::new(),
            target: Value::Null,
            foreground_pid: 0,
            page_limit: 2,
            events,
        };
        fixture.start(false);
        fixture.target = fixture.wait_for_state("target.json");
        let deadline = Instant::now() + Duration::from_secs(5);
        while {
            let state = fixture.wait_for_state("target.json");
            state["active"] != true || state["keyWindowId"] != state["windowId"]
        } {
            assert!(
                Instant::now() < deadline,
                "Target fixture did not initialize AppKit focus"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        fixture.foreground_pid = fixture.start(true);
        fixture.wait_for_state("foreground.json");
        let deadline = Instant::now() + Duration::from_secs(5);
        while fixture.probe()["frontmostPid"] != json!(fixture.foreground_pid) {
            assert!(
                Instant::now() < deadline,
                "The distraction fixture could not become foreground"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        fixture
    }

    fn start(&mut self, foreground: bool) -> u32 {
        let file = if foreground {
            "foreground.json"
        } else {
            "target.json"
        };
        let mut command = Command::new(&self.binary);
        command
            .arg("--state-file")
            .arg(self.directory.path().join(file));
        if foreground {
            command.arg("--foreground");
        } else if self.events {
            command.arg("--events");
        }
        let process = command
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start local fixture");
        let pid = process.id();
        self.processes.push(process);
        pid
    }

    fn wait_for_state(&self, file: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(bytes) = std::fs::read(self.directory.path().join(file)) {
                if let Ok(value) = serde_json::from_slice(&bytes) {
                    return value;
                }
            }
            assert!(Instant::now() < deadline, "Fixture did not publish {file}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    pub(super) fn probe(&self) -> Value {
        let output = Command::new(&self.binary)
            .arg("--probe")
            .output()
            .expect("desktop probe");
        assert!(output.status.success(), "Read-only desktop probe failed");
        serde_json::from_slice(&output.stdout).expect("desktop probe JSON")
    }

    pub(super) fn assert_effect(&self, field: &str, expected: Value) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let actual = self.wait_for_state("target.json");
            if actual[field] == expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "Target {field} did not change: actual={} expected={expected}",
                actual[field]
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub(super) fn state(&self) -> Value {
        self.wait_for_state("target.json")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for process in self.processes.iter_mut().rev() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}
