//! Management commands use the same authenticated RPCs as desktop/mobile.

use anyhow::{bail, Context, Result};
use miniq_protocol::{AgentHistoryCursor, HistoryCursor};
use serde_json::{json, Value};
use std::io::{self, IsTerminal, Read};

use crate::client::Client;
use crate::manage_args::{AgentCommand, QueueCommand, QueueDirection, SessionCommand};
use crate::output::terminal_text;

#[path = "manage_render.rs"]
mod render;
#[path = "manage_session.rs"]
mod session;

pub use render::render_history;

pub enum ManageCommand {
    Session(SessionCommand),
    Queue(QueueCommand),
    Agent(AgentCommand),
}

pub async fn dispatch(client: &mut Client, command: ManageCommand) -> Result<u8> {
    match command {
        ManageCommand::Session(command) => session::run(client, command).await,
        ManageCommand::Queue(command) => queue(client, command).await,
        ManageCommand::Agent(command) => {
            let (method, params, json) = agent_request(command)?;
            let result = client.call(method, params).await?;
            print_result(&result, json)
        }
    }
}

pub fn print_history(value: &Value, json: bool) -> Result<u8> {
    if json || !io::stdout().is_terminal() {
        print_json(value)?;
    } else {
        print!("{}", render_history(value));
    }
    Ok(0)
}

fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn print_result(value: &Value, json: bool) -> Result<u8> {
    if json || !io::stdout().is_terminal() {
        print_json(value)?;
    } else {
        println!("{}", terminal_text(&serde_json::to_string_pretty(value)?));
    }
    Ok(0)
}

fn history_cursor(value: Option<String>) -> Result<Value> {
    let Some(value) = value else {
        return Ok(Value::Null);
    };
    let cursor: HistoryCursor = serde_json::from_str(&value)
        .context("--before requires a history nextCursor JSON object")?;
    Ok(serde_json::to_value(cursor)?)
}

fn content(value: String) -> Result<String> {
    let value = if value == "-" {
        let mut value = String::new();
        io::stdin().read_to_string(&mut value)?;
        value
    } else {
        value
    };
    if value.trim().is_empty() {
        bail!("message text must not be empty");
    }
    Ok(value)
}

async fn queue(client: &mut Client, command: QueueCommand) -> Result<u8> {
    let (session, id) = match &command {
        QueueCommand::List(target) => {
            let value = client
                .call("session.queueList", json!({"sessionId":target.session}))
                .await?;
            return print_result(&value, target.json);
        }
        QueueCommand::Update { session, id, .. } | QueueCommand::Move { session, id, .. } => {
            (session, id)
        }
        QueueCommand::Remove(target) | QueueCommand::Steer(target) => (&target.session, &target.id),
    };
    // Read the current item immediately before mutation. The daemon compares
    // expectedContent/expectedPosition atomically, including mobile edits.
    let queue = client
        .call("session.queueList", json!({"sessionId":session}))
        .await?;
    let item = queue["queue"]
        .as_array()
        .context("daemon did not return the session queue")?
        .iter()
        .find(|item| item["id"].as_str() == Some(id))
        .with_context(|| format!("queued message {id} is no longer in session {session}"))?;
    let (method, params, json) = queue_request(command, item)?;
    let result = client.call(method, params).await?;
    print_result(&result, json)
}

fn queue_request(command: QueueCommand, observed: &Value) -> Result<(&'static str, Value, bool)> {
    Ok(match command {
        QueueCommand::Update {
            session,
            id,
            content: text,
            json,
        } => (
            "session.queueUpdate",
            json!({"sessionId":session,"queuedMessageId":id,
                "expectedContent":observed["content"].as_str().context("queued content missing")?,
                "expectedAttachments":observed["attachments"].clone(),
                "content":content(text)?}),
            json,
        ),
        QueueCommand::Move {
            session,
            id,
            direction,
            json,
        } => (
            "session.queueMove",
            json!({"sessionId":session,"queuedMessageId":id,
                "expectedPosition":observed["position"].as_i64().context("queued position missing")?,
                "direction":match direction { QueueDirection::Up => "up", QueueDirection::Down => "down" }}),
            json,
        ),
        QueueCommand::Remove(target) => (
            "session.queueRemove",
            json!({"queuedMessageId":target.id}),
            target.json,
        ),
        QueueCommand::Steer(target) => (
            "session.queueSteer",
            json!({"queuedMessageId":target.id}),
            target.json,
        ),
        QueueCommand::List(_) => unreachable!("queue listing does not mutate an item"),
    })
}

fn agent_request(command: AgentCommand) -> Result<(&'static str, Value, bool)> {
    Ok(match command {
        AgentCommand::List(target) => (
            "agent.list",
            json!({"sessionId":target.session}),
            target.json,
        ),
        AgentCommand::Output(target) => (
            "agent.output",
            json!({"sessionId":target.session,"agentId":target.agent}),
            target.json,
        ),
        AgentCommand::Stop(target) => (
            "agent.stop",
            json!({"sessionId":target.session,"agentId":target.agent}),
            target.json,
        ),
        AgentCommand::History {
            target,
            limit,
            cursor,
        } => {
            let cursor: Option<AgentHistoryCursor> = cursor
                .map(|cursor| serde_json::from_str(&cursor))
                .transpose()
                .context("--cursor requires an agent history nextCursor JSON object")?;
            (
                "agent.history",
                json!({"sessionId":target.session,"agentId":target.agent,"limit":limit,"cursor":cursor}),
                target.json,
            )
        }
        AgentCommand::Message {
            target,
            revision,
            index,
        } => (
            "agent.message",
            json!({"sessionId":target.session,"agentId":target.agent,"revision":revision,"index":index}),
            target.json,
        ),
    })
}

#[cfg(test)]
#[path = "manage_tests.rs"]
mod tests;
