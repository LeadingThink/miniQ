use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::client::Client;
use crate::output::{progress, terminal_text, Output};

pub fn line(prompt: &str) -> Result<Option<String>> {
    let mut editor = rustyline::DefaultEditor::new()?;
    read_line(&mut editor, prompt)
}

fn read_line(editor: &mut rustyline::DefaultEditor, prompt: &str) -> Result<Option<String>> {
    match editor.readline(prompt) {
        Ok(line) => Ok(Some(line)),
        Err(
            rustyline::error::ReadlineError::Eof | rustyline::error::ReadlineError::Interrupted,
        ) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub async fn wait(
    client: &mut Client,
    session: &str,
    interactive: bool,
    owner: bool,
    output: &mut Output,
    snapshot: Option<Value>,
) -> Result<u8> {
    if let Some(snapshot) = snapshot {
        if let Some(code) = restore(client, session, interactive, output, snapshot).await? {
            return Ok(code);
        }
    }
    loop {
        let event = tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                if owner {
                    client.call("session.cancel", json!({"sessionId":session})).await?;
                    progress("\nCancellation requested. The shared session remains available in every client.");
                } else { progress("\nStopped watching; the remote task was not cancelled."); }
                return Ok(130);
            }
            event = client.next_event() => event,
        };
        let event = match event {
            Ok(event) if event["type"] != "remote_resync" => event,
            _ => {
                progress("\nReconnecting to the same session; no prompt will be resent.");
                let snapshot = client.reconnect(session).await?;
                if let Some(code) = restore(client, session, interactive, output, snapshot).await? {
                    return Ok(code);
                }
                continue;
            }
        };
        output.event(&event)?;
        match event["type"].as_str().unwrap_or("") {
            "turn_completed" => return Ok(0),
            "turn_failed" => {
                progress(&format!(
                    "\n{}",
                    event["error"].as_str().unwrap_or("task failed")
                ));
                return Ok(if event["error"] == "cancelled" {
                    130
                } else {
                    1
                });
            }
            "approval_requested" | "question_requested" => {
                if !interactive {
                    progress(&format!("\nTask needs input. Continue with `miniq resume {session}` or answer from desktop/mobile."));
                    return Ok(3);
                }
                resolve(client, &event).await?;
            }
            _ => {}
        }
    }
}

async fn restore(
    client: &mut Client,
    session: &str,
    interactive: bool,
    output: &mut Output,
    snapshot: Value,
) -> Result<Option<u8>> {
    if output.json {
        println!(
            "{}",
            json!({"type":"cli_snapshot", "sessionId":session, "snapshot":snapshot})
        );
    }
    let last = snapshot["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .rfind(|message| message["role"] == "assistant" || message["role"] == "user");
    if let Some(message) = last.filter(|message| message["role"] == "assistant") {
        output.final_text = message["content"].as_str().unwrap_or("").to_owned();
    }
    let status = snapshot["session"]["status"]
        .as_str()
        .context("session status missing")?;
    if status == "failed" {
        progress(&format!(
            "Session failed. Inspect `miniq history {session}` for its retained evidence."
        ));
        return Ok(Some(1));
    }
    if status == "idle" {
        return Ok(Some(match snapshot["lastTurn"]["status"].as_str() {
            Some("completed") => 0,
            Some("cancelled") => 130,
            _ => {
                progress(
                    "No successful outcome is recorded for this turn; idle does not imply success.",
                );
                1
            }
        }));
    }
    for approval in snapshot["approvals"].as_array().into_iter().flatten() {
        if !interactive {
            return Ok(Some(3));
        }
        let mut event = approval.clone();
        event["type"] = json!("approval_requested");
        resolve(client, &event).await?;
    }
    for question in snapshot["questions"].as_array().into_iter().flatten() {
        if !interactive {
            return Ok(Some(3));
        }
        resolve(
            client,
            &json!({"type":"question_requested", "question":question}),
        )
        .await?;
    }
    Ok(None)
}

async fn resolve(client: &mut Client, event: &Value) -> Result<()> {
    if event["type"] == "approval_requested" {
        progress(&format!(
            "\nApproval: {}\n{}",
            event["toolName"].as_str().unwrap_or("tool"),
            event["input"]
        ));
        let answer = line("Approve once? [y/N] ")?.unwrap_or_default();
        client
            .call(
                "approval.resolve",
                json!({"approvalId":event["approval"]["id"],
            "decision":if answer.eq_ignore_ascii_case("y") {"approve"} else {"reject"}}),
            )
            .await?;
    } else {
        let question = &event["question"];
        progress(&format!(
            "\n{}",
            question["prompt"].as_str().unwrap_or("Question")
        ));
        for option in question["options"].as_array().into_iter().flatten() {
            progress(&format!("  {}", option.as_str().unwrap_or("")));
        }
        let answer = line("Answer: ")?
            .context("question left unanswered; resume the session to continue")?;
        client
            .call(
                "question.resolve",
                json!({"questionId":question["id"],"answer":answer}),
            )
            .await?;
    }
    Ok(())
}

pub async fn interactive(
    client: &mut Client,
    session: &str,
    mut initial: Option<String>,
    options: &crate::args::ChatOptions,
) -> Result<u8> {
    let mut files = options.attachments.clone();
    // Keep prompt history in this process only; never persist messages or API Keys to disk.
    let mut editor = rustyline::DefaultEditor::new()?;
    progress(&format!("miniQ {} · Session: {session}\n/model selects this session's model; /effort selects supported reasoning. /help lists commands.\nCtrl+C during a task cancels it; /exit between turns detaches.", env!("CARGO_PKG_VERSION")));
    let selection = client
        .call("session.modelGet", json!({"sessionId":session}))
        .await?;
    if let Some(model) = selection["effective"]["model"].as_str() {
        progress(&format!(
            "Model: {model} · reasoning: {}",
            selection["effective"]["reasoningEffort"]
                .as_str()
                .unwrap_or("default")
        ));
    }
    let snapshot = client
        .call("session.open", json!({"sessionId":session}))
        .await?;
    if snapshot["session"]["status"] != "idle" && snapshot["session"]["status"] != "failed" {
        let mut output = Output::new(false);
        let code = wait(client, session, true, false, &mut output, Some(snapshot)).await?;
        output.finish(session, code, None);
        if code == 130 {
            return Ok(code);
        }
    }
    loop {
        let prompt = match initial.take() {
            Some(prompt) => prompt,
            None => match read_line(&mut editor, "miniq> ")? {
                Some(line) => line,
                None => return Ok(0),
            },
        };
        let text = prompt.trim();
        if text.is_empty() && files.is_empty() {
            continue;
        }
        editor.add_history_entry(&prompt)?;
        if text.starts_with('/') {
            if command(client, session, text, &mut files).await? {
                return Ok(0);
            }
            continue;
        }
        if let Err(error) = crate::sessions::send(client, session, &prompt, &files).await {
            progress(&format!("{error:#}"));
            continue;
        }
        files.clear();
        let mut output = Output::new(false);
        let code = wait(client, session, true, true, &mut output, None).await?;
        output.finish(session, code, None);
    }
}

async fn command(
    client: &mut Client,
    session: &str,
    text: &str,
    files: &mut Vec<std::path::PathBuf>,
) -> Result<bool> {
    let (command, arg) = text.split_once(' ').unwrap_or((text, ""));
    let arg = arg.trim();
    let result = match command {
        "/exit" | "/quit" => return Ok(true),
        "/help" => {
            progress("/model              Search/select a text model for this session\n/model MODEL        Switch this session to an exact model ID\n/effort             Select a supported reasoning effort\n/effort LEVEL       Set effort, or default to clear the override\n/attach PATH        Add a file to the next message\n/clear-attachments  Remove pending attachments\n/status             Show this session's effective model\n/history            Show recent messages and the next history cursor\n/exit               Leave the terminal without deleting the session\n\nContinue later: miniq resume (searchable project sessions), or miniq resume --last.\nFor multiline tasks: pipe a file to miniq exec -. History pagination: miniq history SESSION --before CURSOR.");
            Ok(())
        }
        "/attach" if !arg.is_empty() => {
            let file = std::path::PathBuf::from(arg);
            let mut candidate = files.clone();
            candidate.push(file);
            match crate::sessions::attachments(&candidate) {
                Ok(_) => {
                    *files = candidate;
                    progress(&format!("{} attachment(s)", files.len()));
                    Ok(())
                }
                Err(error) => Err(error),
            }
        }
        "/clear-attachments" => {
            files.clear();
            Ok(())
        }
        "/model" | "/effort" => change_model(client, session, command, arg).await,
        "/status" | "/history" => {
            let method = if command == "/status" {
                "session.modelGet"
            } else {
                "session.history"
            };
            let result = client.call(method, json!({"sessionId":session})).await?;
            println!("{}", terminal_text(&serde_json::to_string_pretty(&result)?));
            Ok(())
        }
        _ => {
            progress("Unknown or incomplete command. /help lists commands.");
            Ok(())
        }
    };
    if let Err(error) = result {
        progress(&format!("{error:#}"));
    }
    Ok(false)
}

async fn change_model(client: &mut Client, session: &str, command: &str, arg: &str) -> Result<()> {
    let selected = if !arg.is_empty() {
        Some(arg.to_owned())
    } else {
        let state = client
            .call("session.modelGet", json!({"sessionId":session}))
            .await?;
        if command == "/model" {
            crate::selection::model(client, state["effective"]["model"].as_str()).await?
        } else {
            choose_effort(client, &state).await?
        }
    };
    let Some(selected) = selected else {
        return Ok(());
    };
    let options = crate::args::ChatOptions {
        model: (command == "/model").then(|| selected.clone()),
        effort: (command == "/effort").then(|| selected.clone()),
        ..Default::default()
    };
    crate::sessions::update_model(client, session, &options).await?;
    progress(&format!(
        "{}: {selected} — saved for this session only.",
        command.trim_start_matches('/')
    ));
    Ok(())
}

async fn choose_effort(client: &mut Client, state: &Value) -> Result<Option<String>> {
    let model = state["effective"]["model"]
        .as_str()
        .context("select a model first")?;
    let description = client
        .call(
            "model.describe",
            json!({"model":model,"apiProtocol":state["effective"]["apiProtocol"]}),
        )
        .await?;
    let mut choices = vec![crate::selection::Choice::plain("default")];
    for effort in description["reasoningEfforts"]
        .as_array()
        .context("invalid reasoning capabilities")?
    {
        choices.push(crate::selection::Choice::plain(
            effort.as_str().context("invalid reasoning effort")?,
        ));
    }
    crate::selection::choose(
        &format!("Reasoning for {model} — this session only"),
        &choices,
        Some(
            state["effective"]["reasoningEffort"]
                .as_str()
                .unwrap_or("default"),
        ),
    )
}
