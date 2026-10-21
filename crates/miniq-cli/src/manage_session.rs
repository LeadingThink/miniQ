//! Session mutations and paginated diagnostic reads.

use std::{collections::HashSet, time::Duration};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::{content, history_cursor, print_history, print_result};
use crate::client::Client;
use crate::manage_args::{GoalCommand, GoalStatus, SessionCommand, ShareCommand};

pub(super) async fn run(client: &mut Client, command: SessionCommand) -> Result<u8> {
    match command {
        SessionCommand::Goal { command } => goal(client, command).await,
        SessionCommand::Share { command } => share(client, command).await,
        SessionCommand::Rewrite {
            session,
            message,
            content: text,
            attachments,
            clear_attachments,
            json,
        } => {
            let text = content(text)?;
            let attachments = if clear_attachments {
                Vec::new()
            } else if !attachments.is_empty() {
                crate::sessions::attachments(&attachments)?
            } else {
                original_attachments(client, &session, &message).await?
            };
            let value = client.call("session.rewriteMessage", json!({"sessionId":session,
                "messageId":message,"message":{"role":"user","content":text,"attachments":attachments}})).await?;
            print_result(&value, json)
        }
        command => {
            let (method, params, json) = request(command)?;
            let value = client.call(method, params).await?;
            if method == "session.processRecords" {
                print_history(&value, json)
            } else {
                print_result(&value, json)
            }
        }
    }
}

pub(super) fn request(command: SessionCommand) -> Result<(&'static str, Value, bool)> {
    Ok(match command {
        SessionCommand::Pause(target) => (
            "session.pause",
            json!({"sessionId":target.session}),
            target.json,
        ),
        SessionCommand::Resume(target) => (
            "session.resume",
            json!({"sessionId":target.session}),
            target.json,
        ),
        SessionCommand::RevertTurn {
            session,
            turn,
            force,
            json,
        } => (
            "session.revertTurn",
            json!({"sessionId":session,"turnId":turn,"force":force}),
            json,
        ),
        SessionCommand::AcknowledgeFailure {
            session,
            updated_at,
            json,
        } => (
            "session.acknowledgeFailure",
            json!({"sessionId":session,"updatedAt":updated_at}),
            json,
        ),
        SessionCommand::Search { query, limit, json } => {
            ("session.search", json!({"query":query,"limit":limit}), json)
        }
        SessionCommand::Pin { target, off } => (
            "session.setPinned",
            json!({"sessionId":target.session,"pinned":!off}),
            target.json,
        ),
        SessionCommand::Archive { target, off } => (
            "session.setArchived",
            json!({"sessionId":target.session,"archived":!off}),
            target.json,
        ),
        SessionCommand::Delete { target, yes } => {
            if !yes {
                bail!("deleting a session requires --yes");
            }
            (
                "session.delete",
                json!({"sessionId":target.session}),
                target.json,
            )
        }
        SessionCommand::Events(page) => (
            "session.executionEvents",
            json!({"sessionId":page.session,"agentId":page.agent,"limit":page.limit,"before":history_cursor(page.before)?}),
            page.json,
        ),
        SessionCommand::ModelCalls(page) => (
            "session.modelCalls",
            json!({"sessionId":page.session,"agentId":page.agent,"limit":page.limit,"before":history_cursor(page.before)?}),
            page.json,
        ),
        SessionCommand::Process {
            session,
            turn,
            limit,
            before,
            include_internal,
            json,
        } => (
            "session.processRecords",
            json!({"sessionId":session,"turnId":turn,"limit":limit,"before":history_cursor(before)?,"includeInternal":include_internal}),
            json,
        ),
        SessionCommand::ToolDetail {
            session,
            tool,
            json,
        } => (
            "tool.detail",
            json!({"sessionId":session,"toolCallId":tool}),
            json,
        ),
        SessionCommand::Goal { .. }
        | SessionCommand::Share { .. }
        | SessionCommand::Rewrite { .. } => {
            unreachable!("these commands coordinate more than one request")
        }
    })
}

async fn original_attachments(
    client: &mut Client,
    session: &str,
    message: &str,
) -> Result<Vec<String>> {
    let mut before = Value::Null;
    loop {
        let page = client
            .call(
                "session.history",
                json!({"sessionId":session,
            "limit":100,"filter":"answers","before":before}),
            )
            .await?;
        let messages = page["messages"]
            .as_array()
            .context("daemon history messages missing")?;
        if let Some(found) = messages
            .iter()
            .find(|item| item["id"].as_str() == Some(message))
        {
            if found["role"] != "user" {
                bail!("only a user message can be rewritten");
            }
            return attachment_paths(found);
        }
        let next = page
            .get("nextCursor")
            .context("daemon history cursor missing")?;
        if next.is_null() {
            bail!("user message {message} was not found in session {session}");
        }
        if next == &before {
            bail!("daemon history cursor did not advance");
        }
        before = next.clone();
    }
}

pub(super) fn attachment_paths(message: &Value) -> Result<Vec<String>> {
    match message.get("attachments") {
        None => Ok(Vec::new()),
        Some(Value::Array(files)) => files
            .iter()
            .map(|file| {
                file["path"]
                    .as_str()
                    .map(str::to_owned)
                    .context("saved attachment path missing")
            })
            .collect(),
        Some(_) => bail!("saved message attachments are invalid"),
    }
}

async fn goal(client: &mut Client, command: GoalCommand) -> Result<u8> {
    let session = match &command {
        GoalCommand::Get(target) => &target.session,
        GoalCommand::Set { session, .. } | GoalCommand::Status { session, .. } => session,
    };
    let result = client
        .call("session.goal.get", json!({"sessionId":session}))
        .await?;
    match command {
        GoalCommand::Get(target) => print_result(&result, target.json),
        GoalCommand::Set {
            session,
            goal,
            token_budget,
            clear_token_budget,
            json,
        } => {
            let params = goal_set_params(
                &session,
                goal,
                token_budget,
                clear_token_budget,
                &result["goal"],
            )?;
            let value = client.call("session.goal.update", params).await?;
            print_result(&value, json)
        }
        GoalCommand::Status {
            session,
            status,
            json,
        } => {
            let saved = &result["goal"];
            let params = goal_status_params(&session, status, saved)?;
            // Match desktop's semantics: stop/resume execution first, then
            // persist the goal state. Failed control calls leave it unchanged.
            let method = match status {
                GoalStatus::Active => "session.resume",
                GoalStatus::Paused => "session.pause",
                GoalStatus::Cancelled | GoalStatus::Completed => "session.cancel",
            };
            client.call(method, json!({"sessionId":session})).await?;
            let value = client.call("session.goal.update", params).await?;
            print_result(&value, json)
        }
    }
}

pub(super) fn goal_set_params(
    session: &str,
    goal: String,
    budget: Option<u64>,
    clear: bool,
    saved: &Value,
) -> Result<Value> {
    if goal.trim().is_empty() || goal.trim().chars().count() > 2000 {
        bail!("goal must contain 1–2000 characters");
    }
    if budget == Some(0) {
        bail!("token budget must be positive");
    }
    Ok(json!({"sessionId":session,"goal":goal,
        "status":saved["status"].as_str().unwrap_or("active"),
        "tokenBudget":if clear { Value::Null } else { budget.map_or_else(|| saved["tokenBudget"].clone(), |budget| json!(budget)) }}))
}

pub(super) fn goal_status_params(
    session: &str,
    status: GoalStatus,
    saved: &Value,
) -> Result<Value> {
    let text = saved["goal"]
        .as_str()
        .context("no saved goal; use miniq session goal set SESSION_ID TEXT")?;
    let status = match status {
        GoalStatus::Active => "active",
        GoalStatus::Paused => "paused",
        GoalStatus::Cancelled => "cancelled",
        GoalStatus::Completed => "completed",
    };
    Ok(json!({"sessionId":session,"goal":text,"status":status,"tokenBudget":saved["tokenBudget"]}))
}

async fn share(client: &mut Client, command: ShareCommand) -> Result<u8> {
    let (method, params, json) = share_request(command)?;
    let value = if method == "session.shareCreate" {
        client
            .call_with_timeout(method, params, Duration::from_secs(15 * 60))
            .await?
    } else {
        client.call(method, params).await?
    };
    print_result(&value, json)
}

pub(super) fn share_request(command: ShareCommand) -> Result<(&'static str, Value, bool)> {
    Ok(match command {
        ShareCommand::Create {
            session,
            id,
            title,
            messages,
            artifacts,
            days,
            include_details,
            json,
        } => {
            if title.trim().is_empty() || title.chars().count() > 300 {
                bail!("share title must contain 1–300 characters");
            }
            if messages.is_empty()
                || messages.iter().collect::<HashSet<_>>().len() != messages.len()
            {
                bail!("select at least one message, without repeated IDs");
            }
            if artifacts.len() > 30
                || artifacts.iter().collect::<HashSet<_>>().len() != artifacts.len()
            {
                bail!("select at most 30 artifacts, without repeated IDs");
            }
            (
                "session.shareCreate",
                json!({"sessionId":session,"id":id,"title":title,"messageIds":messages,
                    "artifactIds":artifacts,"expiresInDays":days.parse::<u32>()?,"includeDetails":include_details}),
                json,
            )
        }
        ShareCommand::List { target, after } => (
            "session.shareList",
            json!({"sessionId":target.session,"after":after}),
            target.json,
        ),
        ShareCommand::Revoke { target, id } => (
            "session.shareRevoke",
            json!({"sessionId":target.session,"id":id}),
            target.json,
        ),
    })
}
