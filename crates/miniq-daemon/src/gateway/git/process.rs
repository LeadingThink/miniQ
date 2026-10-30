use super::invalid;
use miniq_protocol::RpcError;
use std::{process::Output, process::Stdio, sync::Arc, sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Semaphore,
    time::{timeout_at, Instant},
};
use tokio_util::sync::CancellationToken;

const GIT_PROCESS_CONCURRENCY: usize = 4;
const GIT_PROCESS_TIMEOUT: Duration = Duration::from_secs(30);

struct Executor {
    slots: Arc<Semaphore>,
    timeout: Duration,
}

fn executor() -> &'static Executor {
    static EXECUTOR: OnceLock<Executor> = OnceLock::new();
    EXECUTOR.get_or_init(|| Executor {
        slots: Arc::new(Semaphore::new(GIT_PROCESS_CONCURRENCY)),
        timeout: GIT_PROCESS_TIMEOUT,
    })
}

pub(super) async fn output(command: Command) -> Result<Output, RpcError> {
    executor().run(command, Vec::new(), None).await
}

pub(super) async fn output_in_index(
    command: Command,
    input: Vec<u8>,
    directory: Arc<tempfile::TempDir>,
) -> Result<Output, RpcError> {
    executor().run(command, input, Some(directory)).await
}

impl Executor {
    async fn run(
        &self,
        mut command: Command,
        input: Vec<u8>,
        directory: Option<Arc<tempfile::TempDir>>,
    ) -> Result<Output, RpcError> {
        let deadline = Instant::now() + self.timeout;
        let slots = self.slots.clone();
        let cancelled = CancellationToken::new();
        let _cancel_on_drop = cancelled.clone().drop_guard();
        // This task owns both the child and its permit. Dropping an RPC kills
        // and reaps its child before another command can occupy that slot.
        tokio::spawn(async move {
            let _directory = directory;
            let permit = tokio::select! {
                _ = cancelled.cancelled() => return Err(invalid("git request cancelled")),
                result = timeout_at(deadline, slots.acquire_owned()) => result
                    .map_err(|_| invalid("git command timed out waiting for a process slot"))?
                    .map_err(|_| invalid("git process executor unavailable"))?,
            };
            // Even a stream of immediately completed commands must let network
            // workers process health checks, cancellation and child exit events.
            tokio::task::yield_now().await;
            if cancelled.is_cancelled() {
                return Err(invalid("git request cancelled"));
            }
            if Instant::now() >= deadline {
                return Err(invalid("git command timed out waiting for a process slot"));
            }
            command
                .kill_on_drop(true)
                .stdin(if input.is_empty() { Stdio::null() } else { Stdio::piped() })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(unix)]
            command.process_group(0);
            let mut child = command.spawn().map_err(|error| invalid(format!("git is unavailable: {error}")))?;
            let mut process = crate::hooks::HookProcessGuard::new(child.id());
            let mut stdin = child.stdin.take();
            let mut stdout = child.stdout.take().expect("piped git stdout");
            let mut stderr = child.stderr.take().expect("piped git stderr");
            let result = tokio::select! {
                _ = cancelled.cancelled() => Err(invalid("git request cancelled")),
                result = timeout_at(deadline, async {
                    let mut out = Vec::new();
                    let mut err = Vec::new();
                    let write = async {
                        if let Some(mut stdin) = stdin.take() {
                            stdin.write_all(&input).await?;
                            stdin.shutdown().await?;
                        }
                        Ok::<_, std::io::Error>(())
                    };
                    let (_, _, _, status) = tokio::try_join!(
                        write, stdout.read_to_end(&mut out), stderr.read_to_end(&mut err), child.wait()
                    )?;
                    Ok::<_, std::io::Error>(Output { status, stdout: out, stderr: err })
                }) => match result {
                    Ok(result) => result.map_err(|error| invalid(format!("git command failed: {error}"))),
                    Err(_) => Err(invalid("git command timed out")),
                },
            };
            if result.is_err() {
                // Git may run attribute filters even with --no-textconv. Reuse
                // tree cleanup so those descendants cannot outlive the slot.
                let _ = tokio::task::spawn_blocking(move || drop(process)).await;
                let _ = child.start_kill();
                let _ = child.wait().await;
            } else {
                process.disarm();
            }
            drop(permit);
            result
        })
        .await
        .map_err(|error| invalid(format!("git process executor failed: {error}")))?
    }
}

#[cfg(test)]
mod tests;
