use anyhow::{bail, Context, Result};
use semver::Version;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

const MANIFEST_URL: &str = "https://oss.zaiwen.top/releases/miniq/terminal.json";
const MANAGED_MARKER: &str = "miniq-terminal-v1";

/// Updating only changes the installed executables. It never connects to, starts,
/// stops, or migrates a live daemon or its database.
pub async fn run(check: bool) -> Result<u8> {
    let http = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
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
    let current = Version::parse(env!("CARGO_PKG_VERSION"))?;
    let latest = release_version(&manifest)?;
    println!("miniQ CLI {current} · Latest {latest}");
    if latest <= current {
        println!("Already up to date.");
        return Ok(0);
    }
    if check {
        println!("Run `miniq update` to install {latest}.");
        return Ok(0);
    }
    let executable = std::env::current_exe()?.canonicalize()?;
    let directory = install_directory(&executable)?;
    install(&directory, &latest.to_string()).await?;
    println!("Updated miniQ CLI to {latest}. Start `miniq` again to use it.");
    println!("Running tasks continue unchanged. A running older daemon adopts the new version after its next normal restart.");
    Ok(0)
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
