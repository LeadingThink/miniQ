//! Real SSH acceptance fixtures supplied by scripts/test-ssh-smoke.mjs.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use super::{process, SshHostManager};
use crate::remote::connection::tests::{next_payload, request, start, Socket};

const FIRST: &str = "miniq-smoke";
const SECOND: &str = "miniq-smoke-two";

struct Fixture {
    config: PathBuf,
    project: PathBuf,
    workspace: String,
    session: String,
}

impl Fixture {
    fn from_script() -> Self {
        let env = |name| std::env::var(name).expect("run scripts/test-ssh-smoke.mjs");
        let config = PathBuf::from(env("MINIQ_SSH_SMOKE_CONFIG"));
        let project = PathBuf::from(env("MINIQ_SSH_SMOKE_PROJECT"));
        let root = config.parent().expect("private fixture directory");
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("miniq-ssh-smoke-"));
        assert!(
            project.starts_with(root),
            "only the owned fixture project may be read"
        );
        Self {
            config,
            project,
            workspace: env("MINIQ_SSH_SMOKE_WORKSPACE"),
            session: env("MINIQ_SSH_SMOKE_SESSION"),
        }
    }

    async fn connect(&self, manager: &Arc<SshHostManager>, host: &str) {
        let base = process::ssh_command(host);
        let mut command = tokio::process::Command::new("ssh");
        command
            .arg("-F")
            .arg(&self.config)
            .args(base.as_std().get_args());
        assert_eq!(
            manager.connect_with(host, command).await.unwrap()["state"],
            "connected"
        );
    }
}

struct Mobile {
    socket: Socket,
    events: Vec<Value>,
    sequence: usize,
}

impl Mobile {
    async fn response(&mut self, method: &str, params: Value) -> Value {
        self.sequence += 1;
        let id = format!("ssh-mobile-{}", self.sequence);
        request(&mut self.socket, &id, method, params).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let value = next_payload(&mut self.socket).await;
                if value["id"] == id {
                    return value;
                }
                self.record(value);
            }
        })
        .await
        .expect("encrypted SSH response")
    }

    fn record(&mut self, value: Value) {
        if let Some(items) = value["items"]
            .as_array()
            .filter(|_| value["type"] == "remote_batch")
        {
            self.events.extend(items.iter().cloned());
        } else {
            self.events.push(value);
        }
    }

    async fn call(&mut self, host: &str, method: &str, params: Value) -> Value {
        let response = self
            .response(
                "host.call",
                json!({"hostId":host,"method":method,"params":params}),
            )
            .await;
        assert!(
            response.get("error").is_none(),
            "{method}: {}",
            response["error"]
        );
        response["result"].clone()
    }

    async fn running_task(&mut self, host: &str, fixture: &Fixture) {
        let open = self
            .call(host, "session.open", json!({"sessionId":fixture.session}))
            .await;
        assert_eq!(
            open["session"]["status"], "running",
            "disconnect must not cancel the task"
        );
        assert_eq!(
            open["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "user")
                .count(),
            1,
            "no request replay after detach/reconnect"
        );
    }
}

async fn inspect_remote_data(mobile: &mut Mobile, fixture: &Fixture) {
    for host in [FIRST, SECOND] {
        let health = mobile.call(host, "daemon.health", Value::Null).await;
        assert_eq!(health["protocolVersion"], miniq_protocol::PROTOCOL_VERSION);
        let workspaces = mobile.call(host, "workspace.list", Value::Null).await;
        assert!(workspaces["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|workspace| workspace["id"] == fixture.workspace));
        let sessions = mobile
            .call(
                host,
                "session.list",
                json!({"workspaceId":fixture.workspace}),
            )
            .await;
        assert!(sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["id"] == fixture.session));
        mobile.running_task(host, fixture).await;
    }
    let file = fixture.project.join("fixture.txt");
    let description = mobile
        .call(
            FIRST,
            "file.describe",
            json!({"sessionId":fixture.session,"path":file}),
        )
        .await;
    let read = mobile.call(FIRST, "file.read", json!({"sessionId":fixture.session,"path":file,"revision":description["revision"],"offset":0})).await;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(read["dataBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(bytes, b"Only isolated SSH smoke data.\n");
    assert_eq!(read["done"], true);
    for params in [
        json!({"hostId":FIRST,"method":"settings.update","params":{}}),
        json!({"hostId":"not-saved","method":"daemon.health","params":{}}),
        json!({"hostId":FIRST,"method":"host.call","params":{}}),
    ] {
        assert!(mobile
            .response("host.call", params)
            .await
            .get("error")
            .is_some());
    }
    assert_eq!(
        mobile.call(SECOND, "daemon.health", Value::Null).await["protocolVersion"],
        miniq_protocol::PROTOCOL_VERSION
    );
}

async fn inspect_events(mobile: &mut Mobile, fixture: &Fixture) {
    mobile
        .call(
            FIRST,
            "session.rename",
            json!({"sessionId":fixture.session,"title":"Isolated mobile SSH fixture"}),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let received = [FIRST, SECOND].iter().all(|host| {
                mobile.events.iter().any(|value| {
                    value["type"] == "host_event"
                        && value["hostId"] == *host
                        && value["event"]["type"] == "session_renamed"
                        && value["event"]["sessionId"] == fixture.session
                })
            });
            if received {
                break;
            }
            let value = next_payload(&mut mobile.socket).await;
            mobile.record(value);
        }
    })
    .await
    .expect("real SSH events retain both host identities over encrypted relay");
}

#[tokio::test]
#[ignore = "requires scripts/test-ssh-smoke.mjs isolated loopback sshd and active task"]
async fn real_loopback_ssh_bridge() {
    let fixture = Fixture::from_script();
    let (state, socket, task) = start().await;
    let manager = state.ssh_hosts.clone();
    let mut mobile = Mobile {
        socket,
        events: Vec::new(),
        sequence: 0,
    };
    for host in [FIRST, SECOND] {
        manager
            .dispatch("host.save", Some(json!({"hostId":host})))
            .await
            .unwrap();
        fixture.connect(&manager, host).await;
    }
    assert_eq!(manager.hosts.list().unwrap().len(), 2);
    inspect_remote_data(&mut mobile, &fixture).await;
    inspect_events(&mut mobile, &fixture).await;
    let detached = mobile
        .response("host.disconnect", json!({"hostId":FIRST}))
        .await;
    assert_eq!(detached["result"]["state"], "disconnected");
    mobile.running_task(SECOND, &fixture).await;
    fixture.connect(&manager, FIRST).await;
    mobile.running_task(FIRST, &fixture).await;
    state.shutdown.cancel();
    task.await.unwrap().unwrap();
    let directory = state.observations_dir.parent().unwrap();
    assert!(directory
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("miniq-test-"));
    std::fs::remove_dir_all(directory).unwrap();
    println!("PASS: encrypted mobile frames -> daemon host.call -> real SSH bridge -> active history/files/events; two hosts, independent disconnect, no cancellation or replay.");
}
