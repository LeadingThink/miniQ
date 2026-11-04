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
    Completed(jobs::Completion),
    Process(processes::Event),
    Connected(Result<Client>),
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
    repl.preferences = prefs.clone();
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
    let mut connected = true;
    let mut connecting: connection::Connecting = None;
    let code = loop {
        repl.jobs.start(&client.directory, client.max_turns);
        if redraw {
            repl.draw(&editor)?;
            redraw = false;
        }
        let input = tokio::select! {
            key = next_key(&mut repl.keys) => Input::Terminal(key),
            event = client.next_event(), if connected => Input::Daemon(event),
            _ = tick.tick() => Input::Tick,
            completed = repl.jobs.next() => Input::Completed(completed),
            event = repl.processes.next() => Input::Process(event),
            result = connection::next(&mut connecting) => Input::Connected(result),
        };
        let flow = match input {
            Input::Connected(result) => {
                connecting = None;
                match result {
                    Ok(mut new) => {
                        new.scope(&repl.session);
                        if let Some(target) = client.watched() {
                            new.watch(target);
                        }
                        *client = new;
                        connected = true;
                        repl.notice = "Connected".into();
                        repl.history_stale = true;
                    }
                    Err(error) => {
                        repl.notice = format!("Disconnected: {error:#} · ctrl+r reconnect")
                    }
                }
                redraw = true;
                None
            }
            Input::Process(event) => {
                repl.process_event(event);
                redraw = true;
                None
            }
            Input::Completed(completed) => {
                repl.complete(&mut editor, client, completed);
                redraw = true;
                None
            }
            Input::Tick => {
                if repl.ui.reader.as_ref().is_some_and(|reader| {
                    reader.live
                        && reader.error.is_none()
                        && reader.refreshed.elapsed() >= Duration::from_secs(1)
                }) {
                    repl.refresh_reader();
                }
                redraw = true;
                if let Some(notice) = updates.tick() {
                    repl.info(&notice);
                }
                None
            }
            Input::Terminal(None) | Input::Terminal(Some(Err(_))) => Some(0),
            Input::Terminal(Some(Ok(event))) => {
                redraw = true;
                if !connected
                    && connecting.is_none()
                    && matches!(
                        event,
                        Event::Key(KeyEvent {
                            code: KeyCode::Char('r'),
                            modifiers: KeyModifiers::CONTROL,
                            ..
                        })
                    )
                {
                    connecting = connection::start(client.directory.clone(), client.max_turns);
                    repl.notice = "Reconnecting…".into();
                    None
                } else {
                    terminal_event(&mut repl, &mut editor, client, event).await?
                }
            }
            Input::Daemon(event) => {
                match event {
                    Ok(event) => {
                        if repl.switch_request.is_some() || repl.refresh_request.is_some() {
                            repl.snapshot_events.push(event.clone());
                        }
                        if event["sessionId"]
                            .as_str()
                            .is_none_or(|id| id == repl.session)
                            && repl.event(&event)
                        {
                            repl.history_stale = true;
                        }
                    }
                    Err(_) => {
                        connected = false;
                        connecting = connection::start(client.directory.clone(), client.max_turns);
                        repl.notice =
                            "Reconnecting… input stays editable; prompts are not resent".into();
                    }
                }
                redraw = true;
                None
            }
        };
        if let Some(code) = flow {
            break code;
        }
        if repl.history_stale && repl.refresh_request.is_none() {
            repl.history_stale = false;
            let anchor = repl.ui.scroll.and_then(|_| {
                repl.ui
                    .transcript
                    .entries
                    .iter()
                    .find(|entry| entry.message.is_some())
                    .map(|entry| entry.id.clone())
            });
            repl.request(
                "Refreshing conversation",
                jobs::Effect::Refresh,
                requests::Request::Refresh(anchor),
            );
        }
        if repl.context_stale && !repl.running {
            repl.context_stale = false;
            repl.rpc(
                "Updating context",
                jobs::Effect::Context,
                "session.contextUsage",
                json!({"sessionId":repl.session}),
            );
        }
    };
    if let Some(connecting) = connecting {
        connecting.abort();
    }
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
            if let Some(form) = repl.ui.form.as_mut() {
                form.editor.paste(&text);
            } else if let Some(picker) = repl.ui.picker.as_mut() {
                picker.query.push_str(&terminal_text(&text));
                picker.selected = 0;
            } else {
                editor.paste(&text);
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
                if let Err(error) = repl.send(client, &text, true).await {
                    repl.error(&format!("{error:#}"));
                } else {
                    editor.clear();
                }
            }
            Ok(None)
        }
        Action::BackTab => {
            repl.cycle_mode(client).await;
            Ok(None)
        }
        Action::Escape => {
            if repl.running || repl.processes.active(&repl.session).is_some() {
                repl.cancel(client).await;
            }
            Ok(None)
        }
        Action::Interrupt => {
            if repl.running || repl.processes.active(&repl.session).is_some() {
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
        repl.shell(command.trim());
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
        editor.set_buffer(&text);
        repl.error(&format!("{error:#}"));
    }
    Ok(None)
}

pub(super) fn external_editor(repl: &mut Repl, text: &str) -> Result<String> {
    let temporary = tempfile::Builder::new()
        .prefix("miniq-prompt-")
        .suffix(".md")
        .tempfile()?
        .into_temp_path();
    let path: &std::path::Path = temporary.as_ref();
    std::fs::write(&path, text)?;
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| if cfg!(windows) { "notepad.exe" } else { "vi" }.into());
    repl.suspend();
    #[cfg(windows)]
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command"])
        .arg(format!("& {editor} $env:MINIQ_EDITOR_FILE"))
        .env("MINIQ_EDITOR_FILE", &path)
        .status();
    #[cfg(not(windows))]
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$1\""))
        .arg("sh")
        .arg(&path)
        .status();
    repl.resume()?;
    let result = std::fs::read_to_string(&path);
    if !status?.success() {
        anyhow::bail!("editor exited with an error; prompt unchanged");
    }
    Ok(result?)
}
