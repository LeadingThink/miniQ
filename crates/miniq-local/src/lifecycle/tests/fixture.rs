use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::{
    handshake::server::{Request, Response},
    Message,
};

pub(super) struct Fixture(pub tempfile::TempDir);

impl Fixture {
    pub fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }
    pub fn path(&self) -> &Path {
        self.0.path()
    }
    pub async fn start(&self, mode: &str) -> ConnectionInfo {
        ensure(
            self.path(),
            || command(mode),
            Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await
        .unwrap()
    }
    pub async fn record(&self) -> ConnectionInfo {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(info) = read_connection_info(self.path()).unwrap() {
                    return info;
                }
                sleep(POLL).await;
            }
        })
        .await
        .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(Some(info)) = read_connection_info(self.path()) {
            // All records are isolated fixtures; never terminate the test harness itself.
            if info.pid != std::process::id() {
                if let Ok(Some(process)) = DaemonProcess::open(info.pid, &info.process_identity) {
                    let _ = process.stop(Duration::ZERO);
                }
            }
        }
    }
}

pub(super) fn command(mode: &str) -> io::Result<Command> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--exact",
            "lifecycle::tests::fixture::daemon_fixture",
            "--nocapture",
        ])
        .env("MINIQ_LIFECYCLE_FIXTURE", mode);
    Ok(command)
}

#[tokio::test]
async fn daemon_fixture() {
    let Ok(mode) = std::env::var("MINIQ_LIFECYCLE_FIXTURE") else {
        return;
    };
    if mode == "exit" {
        eprintln!("fixture initialization failed: database unavailable");
        std::process::exit(42);
    }
    // Fail-safe for an interrupted test harness, without touching a user's daemon.
    tokio::spawn(async {
        sleep(Duration::from_secs(30)).await;
        std::process::exit(43);
    });
    let directory = crate::data_dir();
    if mode == "lock" {
        let _lock = OperationLock::acquire(&directory, Duration::from_secs(1))
            .await
            .unwrap();
        std::fs::write(directory.join("locked"), b"ready").unwrap();
        sleep(Duration::from_secs(30)).await;
        return;
    }
    let _lock = DaemonLock::acquire(&directory).unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let info = ConnectionInfo::current(
        listener.local_addr().unwrap().port(),
        "fixture token&private".into(),
    )
    .unwrap();
    #[cfg(unix)]
    assert_eq!(unsafe { libc::getsid(0) }, std::process::id() as i32);
    #[cfg(windows)]
    if mode == "deny-terminate" || mode == "deny-query" {
        super::windows::deny_access(if mode == "deny-terminate" { 1 } else { 0x1000 });
    }
    crate::write_connection_info(&directory, &info).unwrap();
    loop {
        let (stream, _) = listener.accept().await.unwrap();
        if mode == "unresponsive" {
            sleep(Duration::from_secs(30)).await;
            continue;
        }
        let mode = mode.clone();
        let directory = directory.clone();
        tokio::spawn(serve_connection(stream, mode, directory));
    }
}

async fn serve_connection(
    stream: tokio::net::TcpStream,
    mode: String,
    directory: std::path::PathBuf,
) {
    let socket =
        tokio_tungstenite::accept_hdr_async(stream, |request: &Request, response: Response| {
            assert_eq!(request.uri().path(), "/ws");
            let pairs: Vec<_> =
                url::form_urlencoded::parse(request.uri().query().unwrap().as_bytes()).collect();
            if pairs != [("token".into(), "fixture token&private".into())] {
                return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                    .status(401)
                    .body(None)
                    .unwrap());
            }
            Ok(response)
        })
        .await;
    let Ok(mut socket) = socket else { return };
    let Some(Ok(Message::Text(text))) = socket.next().await else {
        return;
    };
    let request: Value = serde_json::from_str(&text).unwrap();
    let result = if request["method"] == "daemon.health" {
        json!({"protocolVersion": if mode == "protocol" { u32::MAX } else { miniq_protocol::PROTOCOL_VERSION }, "daemonVersion":"fixture"})
    } else {
        assert_eq!(request["method"], "daemon.shutdown");
        if mode == "shutdown-fails" {
            return;
        }
        std::fs::write(directory.join("graceful"), b"accepted").unwrap();
        json!({"accepted":true})
    };
    let _ = socket
        .send(Message::text(
            json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string(),
        ))
        .await;
    if request["method"] == "daemon.shutdown" {
        std::process::exit(0);
    }
}
