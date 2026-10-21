use anyhow::{bail, Context, Result};
use semver::Version;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::busy_policy;
use crate::client::{self, is_busy, Client};

const MANIFEST_URL: &str = "https://oss.zaiwen.top/releases/miniq/terminal.json";
const MANAGED_MARKER: &str = "miniq-terminal-v1";

/// Installing an immutable pair leaves existing work running. Backend activation
/// is a separate choice protected by the daemon's atomic idle admission gate.
pub async fn run(check: bool, activate: bool, stop_running: bool, directory: &Path) -> Result<u8> {
    if check && (activate || stop_running) {
        bail!("--check cannot activate an update");
    }
    if stop_running && !activate {
        bail!("--stop-running requires --activate");
    }
    let latest = latest_version(Duration::from_secs(45)).await?;
    let current = Version::parse(env!("CARGO_PKG_VERSION"))?;
    let mut daemon = Client::connect(directory).await.ok();
    let health = match &mut daemon {
        Some(client) => Some(client.call("daemon.health", serde_json::json!({})).await?),
        None => None,
    };
    println!("Installed miniQ CLI {current} · Latest {latest}");
    println!(
        "Running backend: {}",
        health
            .as_ref()
            .and_then(|health| health["daemonVersion"].as_str())
            .unwrap_or("not connected; use `miniq doctor` to inspect")
    );
    if check {
        if latest > current {
            println!("Run `miniq update` to install {latest}.");
        } else {
            println!("Installed miniQ CLI is already up to date.");
        }
        println!("Installing leaves running tasks on their current backend. Use `miniq update --activate` to activate when idle.");
        return Ok(0);
    }
    let wanted = latest.max(current.clone());
    let needs_install = wanted > current;
    let backend_current = health
        .as_ref()
        .and_then(|health| health["daemonVersion"].as_str())
        == Some(wanted.to_string().as_str());
    let interactive = busy_policy::interactive();
    if !needs_install && !activate && backend_current {
        println!("CLI and running backend are already up to date.");
        return Ok(0);
    }
    if !needs_install && !activate && (!interactive || daemon.is_none()) {
        println!("Installed miniQ CLI is already up to date. Use `miniq update --activate` to activate its backend when idle.");
        return Ok(0);
    }
    let executable = std::env::current_exe()?.canonicalize()?;
    let install_root = install_directory(&executable)?;
    if needs_install {
        install(&install_root, &wanted.to_string()).await?;
        println!(
            "Installed miniQ CLI and daemon {wanted}. Start `miniq` again to use the updated CLI."
        );
    }
    let should_activate = activate || (!backend_current && interactive && choose_activation()?);
    if !should_activate {
        println!("Running tasks continue. Run `miniq update --activate` later to use the installed backend.");
        return Ok(0);
    }
    if backend_current {
        println!("Running backend is already {wanted}.");
        return Ok(0);
    }
    let binary = install_root.join(if cfg!(windows) {
        "miniq-daemon.exe"
    } else {
        "miniq-daemon"
    });
    if !activate_backend(
        daemon,
        health.as_ref(),
        directory,
        &binary,
        &wanted,
        stop_running,
        interactive,
    )
    .await?
    {
        return Ok(if activate { 3 } else { 0 });
    }
    println!("Running backend is now {wanted}. Sessions and history remain available.");
    Ok(0)
}

pub(crate) async fn latest_version(timeout: Duration) -> Result<Version> {
    let http = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(timeout.min(Duration::from_secs(15)))
        .timeout(timeout)
        .build()?;
    let manifest: Value = http
        .get(MANIFEST_URL)
        .send()
        .await
        .context("cannot check terminal updates; retry `miniq update --check`")?
        .error_for_status()?
        .json()
        .await
        .context("invalid terminal release manifest")?;
    release_version(&manifest)
}

fn choose_activation() -> Result<bool> {
    eprintln!(
        "  1. Activate the installed backend when idle\n  2. Later; keep tasks running (default)"
    );
    Ok(crate::monitor::line("Activate [1/2]: ")?
        .as_deref()
        .is_some_and(|line| line.trim() == "1"))
}

fn choose_stop() -> Result<bool> {
    eprintln!("miniQ has running tasks, requests or queued messages.\n  1. Stop ALL running backend tasks, then activate (queued messages are kept)\n  2. Later; keep every task running (default)");
    Ok(crate::monitor::line("Stop all and activate [1/2]: ")?
        .as_deref()
        .is_some_and(|line| line.trim() == "1"))
}

async fn activate_backend(
    daemon: Option<Client>,
    health: Option<&Value>,
    directory: &Path,
    binary: &Path,
    version: &Version,
    stop_running: bool,
    interactive: bool,
) -> Result<bool> {
    if let Some(mut daemon) = daemon {
        if health.is_none_or(|health| health["capabilities"]["idleShutdown"] != true) {
            bail!("this running backend cannot activate updates safely. The installed update is ready; wait for all tasks to finish and restart the backend normally");
        }
        let port = miniq_local::read_connection_info(directory)
            .context("backend discovery file disappeared; activation was not started")?
            .port;
        match request_shutdown(&mut daemon, stop_running, interactive).await? {
            true => {}
            false => return Ok(false),
        }
        drop(daemon);
        wait_until_stopped(port).await?;
    }
    let mut daemon = client::ensure(directory, Some(binary), false).await?;
    let health = daemon.call("daemon.health", serde_json::json!({})).await?;
    if health["daemonVersion"].as_str() != Some(version.to_string().as_str()) {
        bail!("connected backend version {} differs from installed {version}; run `miniq doctor` before trying activation again", health["daemonVersion"]);
    }
    Ok(true)
}

async fn request_shutdown(
    daemon: &mut Client,
    stop_running: bool,
    interactive: bool,
) -> Result<bool> {
    match daemon
        .call("daemon.shutdownIfIdle", serde_json::json!({}))
        .await
    {
        Ok(result) => {
            if result["accepted"] != true {
                bail!("backend did not accept activation; inspect it with `miniq doctor`");
            }
            return Ok(true);
        }
        Err(error) if is_busy(&error, "daemon.shutdownIfIdle") => {}
        Err(error) => return Err(error),
    }
    if !stop_running && !(interactive && choose_stop()?) {
        println!("Update installed; backend activation deferred while tasks continue. Retry `miniq update --activate` when idle.");
        return Ok(false);
    }
    let result = daemon
        .call("daemon.shutdown", serde_json::json!({}))
        .await?;
    if result["accepted"] != true {
        bail!("backend did not confirm shutdown; inspect it before retrying");
    }
    println!(
        "Stopped {} turn(s) and {} agent(s) for the explicitly requested activation.",
        result["cancelledTurns"], result["cancelledAgents"]
    );
    Ok(true)
}

async fn wait_until_stopped(port: u16) -> Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let connected = tokio::time::timeout(
            Duration::from_secs(1),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await;
        if matches!(connected, Ok(Err(_))) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("backend is still shutting down; the installed update is ready. Run `miniq doctor` before retrying");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn release_version(manifest: &Value) -> Result<Version> {
    let raw = manifest["version"]
        .as_str()
        .context("release version missing")?;
    let version = Version::parse(raw).context("invalid release version")?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        bail!("terminal updates require a stable release version");
    }
    let target = target()?;
    let entry = &manifest["platforms"][target];
    let url = url::Url::parse(
        entry["url"]
            .as_str()
            .context("no release for this platform")?,
    )?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        bail!("invalid terminal archive URL");
    }
    let checksum = entry["sha256"]
        .as_str()
        .context("archive checksum missing")?;
    if checksum.len() != 64 || !checksum.bytes().all(|c| c.is_ascii_hexdigit()) {
        bail!("invalid terminal archive checksum");
    }
    Ok(version)
}

fn target() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        _ => bail!("no prebuilt miniQ terminal for this platform; build from source"),
    }
}

fn install_directory(executable: &Path) -> Result<PathBuf> {
    let parent = executable
        .parent()
        .context("executable directory missing")?;
    // Managed installs resolve symlinks/launchers to bin/.miniq/versions/V/miniq.
    if let Some(versions) = parent
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "versions"))
    {
        if let Some(managed) = versions
            .parent()
            .filter(|p| p.file_name().is_some_and(|n| n == ".miniq"))
        {
            if std::fs::read_to_string(managed.join("managed"))
                .is_ok_and(|v| v.trim() == MANAGED_MARKER)
            {
                return Ok(managed.parent().context("install root missing")?.to_owned());
            }
        }
    }
    // Explicit update also upgrades old extracted CLI+daemon pairs in place.
    // Never install into a signed app bundle or a Cargo build directory.
    let protected = executable.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        name.ends_with(".app") || name == "target" || name == ".miniq"
    });
    let daemon = if cfg!(windows) {
        "miniq-daemon.exe"
    } else {
        "miniq-daemon"
    };
    if !protected && parent.join(daemon).is_file() {
        return Ok(parent.to_owned());
    }
    bail!("this CLI is not a standalone installation; install it from https://oss.zaiwen.top/releases/miniq/install.sh (Windows: install.ps1)")
}

async fn install(directory: &Path, version: &str) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let (script_name, source) = if cfg!(windows) {
        (
            "install.ps1",
            include_str!("../../../scripts/install-cli.ps1"),
        )
    } else {
        (
            "install.sh",
            include_str!("../../../scripts/install-cli.sh"),
        )
    };
    let script = temp.path().join(script_name);
    std::fs::write(&script, source)?;
    let mut command = if cfg!(windows) {
        let mut command = tokio::process::Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        command
    } else {
        tokio::process::Command::new("sh")
    };
    let status = command
        .arg(script)
        .env("MINIQ_VERSION", version)
        .env("MINIQ_INSTALL_DIR", directory)
        .env("MINIQ_NO_MODIFY_PATH", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await
        .context("could not run miniQ installer")?;
    if !status.success() {
        bail!("terminal update failed; no running task was stopped. Fix the installer error above and retry");
    }
    Ok(())
}

#[cfg(test)]
#[path = "updater_tests.rs"]
mod rpc_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> Value {
        json!({"version":"0.1.99", "platforms":{target().unwrap():{
            "url":"https://oss.zaiwen.top/releases/miniq/v0.1.99/terminal.tar.gz", "sha256":"a".repeat(64)
        }}})
    }

    #[test]
    fn requires_valid_stable_platform_metadata() {
        let mut data = manifest();
        assert_eq!(release_version(&data).unwrap(), Version::new(0, 1, 99));
        data["platforms"][target().unwrap()]["url"] = json!("http://example.com/archive");
        assert!(release_version(&data).is_err());
        let mut data = manifest();
        data["platforms"][target().unwrap()]["sha256"] = json!("bad");
        assert!(release_version(&data).is_err());
        data["version"] = json!("0.1.99-beta");
        assert!(release_version(&data).is_err());
    }

    #[test]
    fn resolves_managed_payload_to_stable_bin_directory() {
        let temp = tempfile::tempdir().unwrap();
        let managed = temp.path().join(".miniq");
        std::fs::create_dir_all(managed.join("versions/0.1.53")).unwrap();
        std::fs::write(managed.join("managed"), format!("{MANAGED_MARKER}\n")).unwrap();
        let exe = managed.join("versions/0.1.53/miniq");
        assert_eq!(install_directory(&exe).unwrap(), temp.path());
        std::fs::remove_file(managed.join("managed")).unwrap();
        assert!(install_directory(&exe).is_err());
    }

    #[test]
    fn refuses_source_and_signed_app_locations() {
        let temp = tempfile::tempdir().unwrap();
        for relative in ["target/release", "miniQ.app/Contents/MacOS", "standalone"] {
            let dir = temp.path().join(relative);
            std::fs::create_dir_all(&dir).unwrap();
            let daemon = if cfg!(windows) {
                "miniq-daemon.exe"
            } else {
                "miniq-daemon"
            };
            std::fs::write(dir.join(daemon), "fixture").unwrap();
            assert_eq!(
                install_directory(&dir.join("miniq")).is_ok(),
                relative == "standalone"
            );
        }
    }
}
