//! Terminal input and daemon events share one asynchronous loop.
use super::*;

fn history_path(client: &Client) -> Option<PathBuf> {
    if std::env::var_os("MINIQ_NO_HISTORY").is_some_and(|v| !v.is_empty() && v != "0") {
        return None;
    }
    Some(client.directory.join("cli_history"))
}

enum Input {
    Terminal(Option<io::Result<Event>>),
    Daemon(Result<Value>),
    Tick,
}

async fn next_key(keys: &mut Option<EventStream>) -> Option<io::Result<Event>> {
    match keys {
        Some(keys) => keys.next().await,
        None => std::future::pending().await,
    }
}

pub(crate) async fn run(
    client: &mut Client,
    session: &str,
    initial: Option<String>,
    options: &crate::args::ChatOptions,
) -> Result<u8> {
    let mut repl = Repl::new(session, options);
    let style = repl.style;
    let prefs = prefs::Prefs::load_reporting(&client.directory);
    let (keymap, warnings) = keymap::Keymap::new(&prefs.keybindings);
    for warning in warnings {
        eprintln!("miniq: warning: {warning}");
    }
    repl.prefs_dir = client.directory.clone();
    repl.statusline = statusline::StatusLine::new(prefs.status_line.clone());
    repl.refresh(client).await;
    let snapshot = client
        .call(
            "session.open",
            json!({"sessionId":session,"includePayloads":true}),
        )
        .await?;
    repl.enter_raw()?;
    repl.restore(&snapshot);
    if let Some(title) = snapshot["session"]["title"].as_str() {
        repl.statusline.title = title.to_owned();
    }
    if repl.running {
        repl.info("This session is already running; following its output.");
    }
    let root = repl.working_directory();
    let mut editor = Editor::new(commands::list(), root)
        .with_history(history_path(client))
        .with_keymap(keymap);
    editor.set_vim(prefs.editor_mode == prefs::EditorMode::Vim);
    if let Some(prompt) = initial {
        if let Some(code) = submit(&mut repl, &mut editor, client, prompt).await? {
            repl.suspend();
            return Ok(code);
        }
    }
    let mut updates = crate::update_notice::UpdateNotice::new(&client.directory);
    let mut tick = tokio::time::interval(Duration::from_millis(33));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut redraw = true;
    let code = loop {
        if redraw {
            repl.draw(&editor)?;
            redraw = false;
        }
        let input = tokio::select! {
            key = next_key(&mut repl.keys) => Input::Terminal(key),
            event = client.next_event() => Input::Daemon(event),
            _ = tick.tick() => Input::Tick,
        };
        let flow = match input {
            Input::Tick => {
                redraw = true;
                if let Some(notice) = updates.tick() {
                    repl.info(&notice);
                }
                None
            }
            Input::Terminal(None) | Input::Terminal(Some(Err(_))) => Some(0),
            Input::Terminal(Some(Ok(event))) => {
                redraw = true;
                terminal_event(&mut repl, &mut editor, client, event).await?
            }
            Input::Daemon(event) => {
                let resync = match &event {
                    Ok(event) => repl.event(event),
                    Err(_) => true,
                };
                if resync {
                    repl.info("Reconnecting to the same session; no prompt will be resent.");
                    let snapshot = client.reconnect(&repl.session).await?;
                    repl.restore(&snapshot);
                }
                None
            }
        };
        if let Some(code) = flow {
            break code;
        }
        if repl.history_stale {
            repl.history_stale = false;
            let snapshot = client
                .call(
                    "session.open",
                    json!({"sessionId":repl.session,"includePayloads":true}),
                )
                .await?;
            repl.restore(&snapshot);
        }
        if repl.context_stale && !repl.running {
            repl.refresh_context(client).await;
        }
    };
    repl.suspend();
    println!(
        "{}",
        style.dim(&format!(
            "Session kept. Continue with: miniq resume {}",
            repl.session
        ))
    );
    Ok(code)
}

async fn terminal_event(
    repl: &mut Repl,
    editor: &mut Editor,
    client: &mut Client,
    event: Event,
) -> Result<Option<u8>> {
    match event {
        Event::Paste(text) => {
            if let Some(picker) = repl.ui.picker.as_mut() {
                picker.query.push_str(&terminal_text(&text));
                picker.selected = 0;
            } else {
                editor.insert(&text);
            }
            Ok(None)
        }
        Event::Resize(..) => Ok(None),
        Event::Mouse(event) => match navigation::mouse(repl, editor, client, event).await {
            Ok(flow) => Ok(flow),
            Err(error) => {
                repl.error(&format!("{error:#}"));
                Ok(None)
            }
        },
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            match key_event(repl, editor, client, key).await {
                Ok(flow) => Ok(flow),
                Err(error) => {
                    repl.error(&format!("{error:#}"));
                    Ok(None)
                }
            }
        }
        _ => Ok(None),
    }
}

async fn key_event(
    repl: &mut Repl,
    editor: &mut Editor,
    client: &mut Client,
    mut key: KeyEvent,
) -> Result<Option<u8>> {
    // In raw mode a bare LF (scripts, some terminals) arrives as Ctrl+J: treat it as Enter
    // unless the user rebound Ctrl+J.
    if key.code == KeyCode::Char('j')
        && key.modifiers == KeyModifiers::CONTROL
        && editor.keymap().lookup(&key) == Some(keymap::Command::Submit)
    {
        key = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
    }
    repl.notice.clear();
    match navigation::key(repl, editor, client, key).await? {
        navigation::Flow::Handled => return Ok(None),
        navigation::Flow::Exit(code) => return Ok(Some(code)),
        navigation::Flow::Ignored => {}
    }
    if matches!(repl.cards.front(), Some(Card::Approval { .. }))
        && editor.is_empty()
        && !key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
    {
        if let KeyCode::Char(c @ ('1' | '2' | '3' | '4' | 'y' | 'Y' | 'n' | 'N')) = key.code {
            if let Err(error) = repl.resolve(client, &c.to_string()).await {
                repl.error(&format!("{error:#}"));
            }
            return Ok(None);
        }
    }
    if key.code != KeyCode::Char('c') || !key.modifiers.contains(KeyModifiers::CONTROL) {
        repl.last_interrupt = None;
    }
    match editor.key(key) {
        Action::Redraw => Ok(None),
        Action::Submit(text) => {
            if repl
                .cards
                .front()
                .is_some_and(|c| matches!(c, Card::Question { .. }))
            {
                editor.remember(&text);
                if let Err(error) = repl.resolve(client, &text).await {
                    repl.error(&format!("{error:#}"));
                }
                return Ok(None);
            }
            submit(repl, editor, client, text).await
        }
        Action::Tab => {
            let text = editor.buffer().to_owned();
            if repl.running && !text.trim().is_empty() {
                editor.remember(&text);
                editor.clear();
                if let Err(error) = repl.send(client, &text, true).await {
                    repl.error(&format!("{error:#}"));
                }
            }
            Ok(None)
        }
        Action::BackTab => {
            repl.cycle_mode(client).await;
            Ok(None)
        }
        Action::Escape => {
            if repl.running {
                repl.cancel(client).await;
            }
            Ok(None)
        }
        Action::Interrupt => {
            if repl.running {
                repl.cancel(client).await;
            } else if !editor.is_empty() {
                editor.clear();
            } else if repl
                .last_interrupt
                .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
            {
                return Ok(Some(0));
            } else {
                repl.last_interrupt = Some(Instant::now());
                repl.notice = "Press Ctrl+C again to exit".into();
            }
            Ok(None)
        }
        Action::Eof => Ok(Some(0)),
        Action::ClearScreen => {
            repl.ui.scroll = None;
            if let Some(terminal) = repl.terminal.as_mut() {
                terminal.terminal.clear()?;
            }
            Ok(None)
        }
        Action::External => {
            match external_editor(repl, editor.buffer()) {
                Ok(text) => editor.set_buffer(&text),
                Err(error) => repl.error(&format!("{error:#}")),
            }
            Ok(None)
        }
    }
}

async fn submit(
    repl: &mut Repl,
    editor: &mut Editor,
    client: &mut Client,
    text: String,
) -> Result<Option<u8>> {
    let trimmed = text.trim();
    if trimmed.is_empty() && repl.files.is_empty() {
        return Ok(None);
    }
    editor.remember(&text);
    if let Some(command) = trimmed.strip_prefix('!') {
        shell(repl, command.trim()).await;
        return Ok(None);
    }
    if trimmed.starts_with('/') {
        return match commands::run(repl, editor, client, trimmed).await {
            Ok(flow) => Ok(flow),
            Err(error) => {
                let _ = repl.resume();
                repl.error(&format!("{error:#}"));
                Ok(None)
            }
        };
    }
    if let Err(error) = repl.send(client, &text, false).await {
        repl.error(&format!("{error:#}"));
    }
    Ok(None)
}

/// `!cmd` runs locally in the working directory; output stays on screen and is not sent.
async fn shell(repl: &mut Repl, command: &str) {
    if command.is_empty() {
        repl.notice = "Type ! followed by a shell command".into();
        return;
    }
    repl.emit(&repl.style.bold(&format!("$ {}", terminal_text(command))));
    #[cfg(windows)]
    let mut process = {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.arg("/C");
        c
    };
    #[cfg(not(windows))]
    let mut process = {
        let mut c =
            tokio::process::Command::new(std::env::var("SHELL").unwrap_or_else(|_| "sh".into()));
        c.arg("-c");
        c
    };
    match process
        .arg(command)
        .current_dir(repl.working_directory())
        .kill_on_drop(true)
        .output()
        .await
    {
        Ok(output) => {
            repl.emit(&terminal_text(&String::from_utf8_lossy(&output.stdout)));
            repl.emit(&terminal_text(&String::from_utf8_lossy(&output.stderr)));
            if !output.status.success() {
                repl.error(&format!("Exit status {}", output.status));
            }
        }
        Err(error) => repl.error(&error.to_string()),
    }
}

pub(super) fn external_editor(repl: &mut Repl, text: &str) -> Result<String> {
    let path = std::env::temp_dir().join(format!("miniq-prompt-{}.md", std::process::id()));
    std::fs::write(&path, text)?;
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".into());
    repl.suspend();
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$1\""))
        .arg("sh")
        .arg(&path)
        .status();
    let _ = repl.resume();
    let result = std::fs::read_to_string(&path);
    let _ = std::fs::remove_file(&path);
    if !status?.success() {
        anyhow::bail!("editor exited with an error; prompt unchanged");
    }
    Ok(result?.trim_end_matches('\n').to_owned())
}
