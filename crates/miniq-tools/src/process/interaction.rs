//! Input and terminal resizing for an existing owned process.
use super::*;
use tokio::io::AsyncWriteExt;

impl ProcessManager {
    pub(crate) async fn input(
        &self,
        ctx: &ToolContext,
        id: &str,
        chars: String,
        eof: bool,
    ) -> Result<(), ToolError> {
        if ctx.cancellation.is_cancelled() {
            return Err(failure("cancelled before stdin write"));
        }
        let process = self.owned(ctx, id).await?;
        if chars.is_empty() && !eof {
            return Ok(());
        }
        if !refresh(&process).await? {
            return Err(failure("process has already exited"));
        }
        let terminal_input = {
            let runtime = process.runtime.lock().await;
            match &runtime.child {
                ProcessChild::Terminal(t) => Some(t.input.clone()),
                _ => None,
            }
        };
        if let Some(input) = terminal_input {
            let job = tokio::task::spawn_blocking(move || {
                let mut writer = input.lock().unwrap();
                let writer = writer
                    .as_mut()
                    .ok_or_else(|| failure("terminal input closed"))?;
                writer.write_all(chars.as_bytes()).map_err(failure)?;
                if eof {
                    writer.write_all(&[4]).map_err(failure)?;
                }
                writer.flush().map_err(failure)
            });
            tokio::select! {
                result = job => result.map_err(failure)?,
                _ = ctx.cancellation.cancelled() => stop_uncertain(&process, "cancelled").await,
                _ = tokio::time::sleep(Duration::from_secs(10)) => stop_uncertain(&process, "input stalled").await,
            }
        } else {
            let write = async {
                let mut input = process.input.lock().await;
                let stdin = input
                    .as_mut()
                    .ok_or_else(|| failure("stdin closed; launch with interactive=true"))?;
                stdin.write_all(chars.as_bytes()).await.map_err(failure)?;
                stdin.flush().await.map_err(failure)?;
                if eof {
                    input.take();
                }
                Ok(())
            };
            tokio::select! {
                result = write => result,
                _ = ctx.cancellation.cancelled() => stop_uncertain(&process, "cancelled").await,
                _ = tokio::time::sleep(Duration::from_secs(10)) => stop_uncertain(&process, "input stalled").await,
            }
        }
    }
    pub(crate) async fn resize(
        &self,
        ctx: &ToolContext,
        id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<Value, ToolError> {
        let process = self.owned(ctx, id).await?;
        let runtime = process.runtime.lock().await;
        match &runtime.child {
            ProcessChild::Terminal(t) => t
                .master
                .resize(portable_pty::PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(failure)?,
            _ => return Err(ToolError::InvalidInput("process has no PTY".into())),
        }
        Ok(json!({"session_id":id,"rows":rows,"cols":cols}))
    }
}
async fn stop_uncertain(process: &ManagedProcess, reason: &str) -> Result<(), ToolError> {
    terminate(process).await?;
    Err(failure(format!(
        "{reason}; process stopped; input may have been partially written"
    )))
}
