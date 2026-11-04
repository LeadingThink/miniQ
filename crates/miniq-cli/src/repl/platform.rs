//! Native clipboard and file opening. Dynamic paths are always separate arguments.
use anyhow::{bail, Context, Result};
#[cfg(unix)]
use serde_json::json;
use serde_json::Value;
use std::{
    path::Path,
    process::{Command, Stdio},
};

pub fn open(path: &Path) -> Result<()> {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-Command",
                "Invoke-Item -LiteralPath $env:MINIQ_OPEN_FILE",
            ])
            .env("MINIQ_OPEN_FILE", path);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("open");
        c.arg(path);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = Command::new("xdg-open");
        c.arg(path);
        c
    };
    hidden(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

pub fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

pub fn paste(directory: &Path) -> Result<Value> {
    std::fs::create_dir_all(directory)?;
    let image = directory.join(format!(
        "clipboard-{}.png",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    #[cfg(windows)]
    {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-STA", "-Command", r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
if ([Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [Windows.Forms.Clipboard]::GetImage()
  try { $image.Save($env:MINIQ_CLIP_IMAGE, [Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }
  @{image=$env:MINIQ_CLIP_IMAGE} | ConvertTo-Json -Compress
} elseif ([Windows.Forms.Clipboard]::ContainsText()) {
  @{text=[Windows.Forms.Clipboard]::GetText()} | ConvertTo-Json -Compress
} else { throw 'Clipboard has no text or image' }
"#]).env("MINIQ_CLIP_IMAGE", &image);
        hidden(&mut command);
        let output = command.output()?;
        if !output.status.success() {
            bail!("{}", String::from_utf8_lossy(&output.stderr));
        }
        serde_json::from_slice(&output.stdout).context("reading clipboard")
    }
    #[cfg(unix)]
    {
        #[cfg(target_os = "macos")]
        let tools: &[(&str, &[&str])] = &[("osascript", &["-e", "clipboard info"])];
        #[cfg(not(target_os = "macos"))]
        let tools: &[(&str, &[&str])] = &[
            ("wl-paste", &["--list-types"]),
            ("xclip", &["-selection", "clipboard", "-t", "TARGETS", "-o"]),
        ];
        for (program, args) in tools {
            let Ok(types) = Command::new(program).args(*args).output() else {
                continue;
            };
            if !types.status.success() {
                continue;
            }
            let types = String::from_utf8_lossy(&types.stdout);
            #[cfg(target_os = "macos")]
            {
                if types.contains("PNGf") {
                    let script = "on run argv\nset f to open for access POSIX file (item 1 of argv) with write permission\ntry\nwrite (the clipboard as «class PNGf») to f\nclose access f\non error msg\nclose access f\nerror msg\nend try\nend run";
                    let result = Command::new("osascript")
                        .args(["-e", script])
                        .arg(&image)
                        .output()?;
                    if !result.status.success() {
                        bail!("clipboard image unavailable");
                    }
                    return Ok(json!({"image":image}));
                }
                let output = Command::new("pbpaste").output()?;
                anyhow::ensure!(output.status.success(), "cannot read clipboard");
                return Ok(json!({"text":String::from_utf8(output.stdout)?}));
            }
            #[cfg(not(target_os = "macos"))]
            {
                let is_image = types.lines().any(|kind| kind.trim() == "image/png");
                let mime = if is_image { "image/png" } else { "text/plain" };
                let args = if *program == "wl-paste" {
                    vec!["--no-newline", "--type", mime]
                } else {
                    vec!["-selection", "clipboard", "-t", mime, "-o"]
                };
                let output = Command::new(program).args(args).output()?;
                anyhow::ensure!(output.status.success(), "cannot read clipboard");
                if is_image {
                    std::fs::write(&image, output.stdout)?;
                    return Ok(json!({"image":image}));
                }
                return Ok(json!({"text":String::from_utf8(output.stdout)?}));
            }
        }
        bail!("Clipboard unavailable. Use terminal paste, or install wl-clipboard/xclip.")
    }
}
