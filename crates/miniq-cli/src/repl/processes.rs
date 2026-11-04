//! Streaming local commands. Cancellation kills the owned process, never a daemon turn.
use anyhow::{Context, Result};
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Instant};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;

#[path = "process_tree.rs"]
mod tree;

pub struct Process {
    pub session: String,
    pub title: String,
    pub started: Instant,
    pub output: String,
    pub done: bool,
    cancel: CancellationToken,
}

pub enum Event {
    Output(u64, String),
    Done(u64, Result<String>),
}

pub struct Processes {
    pub items: BTreeMap<u64, Process>,
    tx: mpsc::UnboundedSender<Event>,
    rx: mpsc::UnboundedReceiver<Event>,
    next: u64,
}

impl Default for Processes {
    fn default() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            items: BTreeMap::new(),
            tx,
            rx,
            next: 0,
        }
    }
}

impl Processes {
    pub fn cancel_id(&self, id: u64) {
        if let Some(process) = self.items.get(&id).filter(|process| !process.done) {
            process.cancel.cancel();
        }
    }
    pub fn start(
        &mut self,
        session: &str,
        title: &str,
        program: PathBuf,
        args: Vec<String>,
        cwd: PathBuf,
    ) {
        self.next += 1;
        let id = self.next;
        let cancel = CancellationToken::new();
        self.items.insert(
            id,
            Process {
                session: session.into(),
                title: title.into(),
                started: Instant::now(),
                output: String::new(),
                done: false,
                cancel: cancel.clone(),
            },
        );
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = run(id, program, args, cwd, cancel, tx.clone()).await;
            let _ = tx.send(Event::Done(id, result));
        });
    }

    pub async fn next(&mut self) -> Event {
        self.rx
            .recv()
            .await
            .expect("process sender lives with receiver")
    }

    pub fn cancel(&self, session: &str) -> bool {
        if let Some((_, process)) = self
            .items
            .iter()
            .rev()
            .find(|(_, p)| p.session == session && !p.done)
        {
            process.cancel.cancel();
            true
        } else {
            false
        }
    }

    pub fn active(&self, session: &str) -> Option<&Process> {
        self.items
            .values()
            .rev()
            .find(|p| p.session == session && !p.done)
    }
}

impl Drop for Processes {
    fn drop(&mut self) {
        for process in self.items.values() {
            process.cancel.cancel();
        }
    }
}

async fn run(
    id: u64,
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    cancel: CancellationToken,
    tx: mpsc::UnboundedSender<Event>,
) -> Result<String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().context("could not start command")?;
    let tree = tree::Tree::new(child.id().context("command PID missing")?)?;
    let stdout = child.stdout.take().context("command stdout missing")?;
    let stderr = child.stderr.take().context("command stderr missing")?;
    let finished = async {
        let (status, (), ()) = tokio::try_join!(
            async { Ok::<_, anyhow::Error>(child.wait().await?) },
            pump(id, stdout, tx.clone()),
            pump(id, stderr, tx),
        )?;
        Ok::<_, anyhow::Error>(format!("Exit status {status}"))
    };
    tokio::select! {
        status = finished => status,
        _ = cancel.cancelled() => {
            tree.kill().await?;
            child.wait().await?;
            Ok("Interrupted local command".into())
        }
    }
}

async fn pump(
    id: u64,
    mut source: impl AsyncRead + Unpin,
    tx: mpsc::UnboundedSender<Event>,
) -> Result<()> {
    let mut buffer = [0u8; 8192];
    let mut pending = Vec::new();
    loop {
        let count = source.read(&mut buffer).await?;
        pending.extend_from_slice(&buffer[..count]);
        let complete = if count == 0 {
            pending.len()
        } else {
            match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(error) if error.error_len().is_none() => error.valid_up_to(),
                Err(_) => pending.len(),
            }
        };
        if complete > 0 {
            let text = String::from_utf8_lossy(&pending[..complete]).into_owned();
            if tx.send(Event::Output(id, text)).is_err() {
                break;
            }
            pending.drain(..complete);
        }
        if count == 0 {
            break;
        }
    }
    Ok(())
}

impl super::Repl {
    pub(super) fn process_event(&mut self, event: Event) {
        let (id, text, done) = match event {
            Event::Output(id, text) => (id, text, false),
            Event::Done(id, result) => (
                id,
                format!("\n{}\n", result.unwrap_or_else(|e| format!("{e:#}"))),
                true,
            ),
        };
        let Some(process) = self.processes.items.get_mut(&id) else {
            return;
        };
        process.output.push_str(&text);
        process.done |= done;
        if let Some(reader) = self
            .ui
            .reader
            .as_mut()
            .filter(|reader| reader.process == Some(id))
        {
            reader.body = crate::output::terminal_text(&process.output);
        }
        if process.session == self.session {
            self.ui.transcript.local_output(
                &format!("local:{id}"),
                &format!("$ {}\n{}", process.title, process.output),
            );
        }
    }

    pub(super) fn shell(&mut self, command: &str) {
        if command.is_empty() {
            self.notice = "Type ! followed by a shell command".into();
            return;
        }
        #[cfg(windows)]
        let (program, args) = (PathBuf::from("powershell.exe"), vec!["-NoProfile".into(), "-Command".into(),
            format!("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding; & {{ {command} }}")]);
        #[cfg(not(windows))]
        let (program, args) = (
            PathBuf::from(std::env::var("SHELL").unwrap_or_else(|_| "sh".into())),
            vec!["-c".into(), command.into()],
        );
        self.processes.start(
            &self.session,
            command,
            program,
            args,
            self.working_directory(),
        );
    }
}
