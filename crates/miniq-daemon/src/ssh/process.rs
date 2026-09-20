//! OpenSSH process ownership and bounded JSONL framing. No daemon credentials cross SSH.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
// Linux/macOS remotes. The installer uses ~/.local/bin; Cargo uses ~/.cargo/bin.
const REMOTE_COMMAND: &str = "/bin/sh -lc 'export PATH=\"$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; command -v miniq >/dev/null 2>&1 || { printf \"%s\\n\" MINIQ_CLI_NOT_FOUND >&2; exit 127; }; exec miniq bridge'";

pub struct Bridge {
    pub child: Child,
    pub input: Option<ChildStdin>,
    pub output: FrameReader<BufReader<ChildStdout>>,
    pub version: String,
    stderr: tokio::task::JoinHandle<()>,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.stderr.abort();
        // Child is kill_on_drop: only our local SSH process is terminated.
    }
}

pub fn ssh_command(host: &str) -> Command {
    let mut command = Command::new("ssh");
    command.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ForwardX11=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        host,
        REMOTE_COMMAND,
    ]);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

pub async fn start(mut command: Command) -> Result<Bridge, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 SSH：{error}。请确认已安装 OpenSSH 客户端"))?;
    let input = child.stdin.take().ok_or("SSH 输入不可用")?;
    let mut output = FrameReader::new(BufReader::new(child.stdout.take().ok_or("SSH 输出不可用")?));
    let error = Arc::new(Mutex::new(None));
    let error_capture = error.clone();
    let stderr = child.stderr.take().ok_or("SSH 错误输出不可用")?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = FrameReader::new(BufReader::new(stderr));
        while let Ok(Some(line)) = reader.next().await {
            if let Some(message) = classify_error(&line) {
                if let Ok(mut current) = error_capture.lock() {
                    *current = Some(message);
                }
            }
        }
    });
    let ready = tokio::time::timeout(STARTUP_TIMEOUT, output.next()).await;
    let version = match ready {
        Ok(Ok(Some(line))) => parse_ready(&line),
        Ok(Ok(None)) => Err(
            "SSH 连接已结束。请先在终端运行 ssh 主机名，确认登录和远程 miniq bridge 可用".into(),
        ),
        Ok(Err(message)) => Err(message),
        Err(_) => Err("SSH 连接超过 30 秒未就绪。请检查网络、远程 CLI 与 SSH 登录配置".into()),
    };
    match version {
        Ok(version) => Ok(Bridge {
            child,
            input: Some(input),
            output,
            version,
            stderr: stderr_task,
        }),
        Err(message) => {
            let _ = child.kill().await;
            // Let a terminated process flush its actionable stderr before reporting.
            let _ = tokio::time::timeout(Duration::from_millis(200), async {
                while !stderr_task.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await;
            stderr_task.abort();
            Err(error.lock().ok().and_then(|v| v.clone()).unwrap_or(message))
        }
    }
}

fn parse_ready(line: &str) -> Result<String, String> {
    let ready: serde_json::Value = serde_json::from_str(line)
        .map_err(|_| "远程 CLI 握手格式无效。请勿在非交互 shell 启动脚本向标准输出打印内容")?;
    if ready["type"] != "miniq_bridge_ready" {
        return Err("远程 CLI 未返回 miniQ SSH 握手，请更新远程 miniQ CLI".into());
    }
    if ready["protocolVersion"] != miniq_protocol::PROTOCOL_VERSION {
        return Err("远程 miniQ 协议版本不匹配，请将桌面客户端和远程 CLI 更新到同一版本".into());
    }
    ready["version"]
        .as_str()
        .filter(|version| !version.is_empty())
        .map(str::to_owned)
        .ok_or("远程 miniQ 握手缺少版本信息".into())
}

fn classify_error(line: &str) -> Option<String> {
    // Return known diagnostics, never arbitrary remote logs (which may contain secrets).
    let lower = line.to_ascii_lowercase();
    let message = if lower.contains("host key verification failed")
        || lower.contains("remote host identification has changed")
    {
        "SSH 主机密钥尚未信任或已变化。请先在终端运行 ssh 主机名，核实并确认主机指纹"
    } else if lower.contains("permission denied") {
        "SSH 身份验证失败。请在终端确认 ssh 主机名可免密登录，或先用 ssh-add 解锁密钥；miniQ 不保存 SSH 密码"
    } else if lower.contains("miniq_cli_not_found")
        || lower.contains("unrecognized subcommand 'bridge'")
    {
        "远程主机未安装支持 bridge 的 miniQ CLI。请先安装或更新远程 miniQ CLI"
    } else if lower.contains("could not resolve hostname") {
        "无法解析 SSH 主机名，请检查别名和 ~/.ssh/config"
    } else if lower.contains("connection refused")
        || lower.contains("operation timed out")
        || lower.contains("connection timed out")
    {
        "无法连接远程 SSH 服务，请检查主机、端口、网络与跳板机配置"
    } else {
        return None;
    };
    Some(message.into())
}

pub struct FrameReader<R> {
    reader: R,
    bytes: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> FrameReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            bytes: Vec::new(),
        }
    }

    /// The partial frame lives on self so select! cancellation never drops bytes.
    pub async fn next(&mut self) -> Result<Option<String>, String> {
        loop {
            let chunk = self
                .reader
                .fill_buf()
                .await
                .map_err(|_| "SSH 数据流读取失败")?;
            if chunk.is_empty() {
                return if self.bytes.is_empty() {
                    Ok(None)
                } else {
                    Err("SSH 数据帧意外中断".into())
                };
            }
            let newline = chunk.iter().position(|b| *b == b'\n');
            let length = newline.unwrap_or(chunk.len());
            if self.bytes.len() + length > MAX_FRAME_BYTES {
                return Err("SSH 数据帧超过 16 MiB，请使用分页或文件下载".into());
            }
            self.bytes.extend_from_slice(&chunk[..length]);
            self.reader.consume(length + usize::from(newline.is_some()));
            if newline.is_some() {
                if self.bytes.last() == Some(&b'\r') {
                    self.bytes.pop();
                }
                return String::from_utf8(std::mem::take(&mut self.bytes))
                    .map(Some)
                    .map_err(|_| "SSH 数据帧不是有效 UTF-8".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_requires_matching_protocol_and_cli_version() {
        assert_eq!(
            parse_ready(r#"{"type":"miniq_bridge_ready","protocolVersion":2,"version":"0.1.40"}"#)
                .unwrap(),
            "0.1.40"
        );
        assert!(parse_ready(
            r#"{"type":"miniq_bridge_ready","protocolVersion":1,"version":"old"}"#
        )
        .is_err());
        assert!(parse_ready("welcome to server").is_err());
        assert!(parse_ready(r#"{"type":"miniq_bridge_ready","protocolVersion":2}"#).is_err());
    }

    #[tokio::test]
    async fn frame_reader_rejects_incomplete_invalid_and_oversize_frames() {
        assert_eq!(
            FrameReader::new(&b"{}\nnext\n"[..])
                .next()
                .await
                .unwrap()
                .as_deref(),
            Some("{}")
        );
        assert!(FrameReader::new(&b"{}"[..]).next().await.is_err());
        assert!(FrameReader::new(&b"\xff\n"[..]).next().await.is_err());
        let mut exact = vec![b'a'; MAX_FRAME_BYTES];
        exact.push(b'\n');
        assert_eq!(
            FrameReader::new(exact.as_slice())
                .next()
                .await
                .unwrap()
                .unwrap()
                .len(),
            MAX_FRAME_BYTES
        );
        let long = vec![b'a'; MAX_FRAME_BYTES + 1];
        assert!(FrameReader::new(long.as_slice())
            .next()
            .await
            .unwrap_err()
            .contains("16 MiB"));
    }

    #[test]
    fn ssh_never_forwards_keys_or_opens_remote_ports() {
        let command = ssh_command("user@host");
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|v| v.to_str().unwrap())
            .collect();
        for required in [
            "ForwardAgent=no",
            "StrictHostKeyChecking=yes",
            "BatchMode=yes",
            "ClearAllForwardings=yes",
            "PermitLocalCommand=no",
            "ControlPath=none",
        ] {
            assert!(args.contains(&required));
        }
        assert_eq!(args[args.len() - 2], "user@host");
        assert_eq!(args.last(), Some(&REMOTE_COMMAND));
        assert_eq!(classify_error("secret=do-not-display"), None);
    }
}
