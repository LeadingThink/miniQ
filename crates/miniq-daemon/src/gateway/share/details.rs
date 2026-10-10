//! Optional per-turn context for public shares: the model that answered, the
//! turn duration, the user's choices in question dialogs, and approval results.
//! Tool inputs other than question text, local paths and credentials are never read.
use super::*;
use miniq_protocol::{
    ApprovalStatus, Message, ModelCallPurpose, ModelCallsParams, ToolCallStatus, TurnTimingStatus,
};
use serde_json::Map;
use std::collections::HashMap;

pub(super) struct Details {
    /// Extra public fields per message id.
    pub extras: HashMap<String, Map<String, Value>>,
    pub summary: Value,
}

struct Turn<'a> {
    user: &'a Message,
    /// Exclusive end time; `None` for the last turn.
    end: Option<&'a str>,
}

pub(super) fn build(
    state: &AppState,
    session_id: &str,
    all: &[Message],
    selected: &HashSet<&String>,
) -> Result<Details, RpcError> {
    let users: Vec<&Message> = all.iter().filter(|m| m.role == Role::User).collect();
    let turns: Vec<Turn> = users
        .iter()
        .enumerate()
        .map(|(index, user)| Turn {
            user,
            end: users.get(index + 1).map(|next| next.created_at.as_str()),
        })
        .collect();
    let turn_of = |at: &str| {
        turns.iter().rposition(|turn| {
            turn.user.created_at.as_str() <= at && turn.end.is_none_or(|end| at < end)
        })
    };

    let models = turn_models(state, session_id)?;
    let mut events: Vec<Vec<(String, Value)>> = vec![Vec::new(); turns.len()];
    for call in state.store.list_tool_calls(session_id).map_err(store_err)? {
        if call.agent_id.is_some()
            || call.tool_name != "ask_user"
            || call.status != ToolCallStatus::Succeeded
        {
            continue;
        }
        if let Some(index) = turn_of(&call.created_at) {
            let output = call.output.unwrap_or(Value::Null);
            for question in questions(&call.input, &output) {
                events[index].push((call.created_at.clone(), question));
            }
        }
    }
    for (approval, tool) in state
        .store
        .resolved_approvals(session_id)
        .map_err(store_err)?
    {
        if let Some(index) = turn_of(&approval.created_at) {
            let decision = if approval.status == ApprovalStatus::Rejected {
                "rejected"
            } else {
                "approved"
            };
            events[index].push((
                approval.created_at,
                json!({"type":"approval","tool":tool,"decision":decision}),
            ));
        }
    }

    let mut extras: HashMap<String, Map<String, Value>> = HashMap::new();
    let (mut shared_turns, mut confirmations, mut elapsed) = (0, 0, None::<u64>);
    let mut used_models: Vec<Value> = Vec::new();
    for (index, turn) in turns.iter().enumerate() {
        let in_turn: Vec<&Message> = all
            .iter()
            .filter(|m| {
                m.created_at.as_str() >= turn.user.created_at.as_str()
                    && turn.end.is_none_or(|end| m.created_at.as_str() < end)
                    && selected.contains(&m.id)
            })
            .collect();
        if in_turn.is_empty() {
            continue;
        }
        shared_turns += 1;
        let turn_elapsed = turn
            .user
            .turn_timing
            .as_ref()
            .filter(|timing| timing.status == TurnTimingStatus::Completed)
            .and_then(|timing| timing.elapsed_ms);
        if let Some(ms) = turn_elapsed {
            elapsed = Some(elapsed.unwrap_or(0) + ms);
            if selected.contains(&turn.user.id) {
                extras
                    .entry(turn.user.id.clone())
                    .or_default()
                    .insert("elapsedMs".into(), json!(ms));
            }
        }
        let Some(answer) = in_turn.iter().find(|m| m.role == Role::Assistant) else {
            continue;
        };
        let fields = extras.entry(answer.id.clone()).or_default();
        if let Some((model, effort)) = models.get(&turn.user.id) {
            fields.insert("model".into(), json!(model));
            if let Some(effort) = effort {
                fields.insert("effort".into(), json!(effort));
            }
            let entry = json!({"model": model, "effort": effort});
            if !used_models.contains(&entry) {
                used_models.push(entry);
            }
        }
        let mut turn_events = std::mem::take(&mut events[index]);
        if !turn_events.is_empty() {
            turn_events.sort_by(|a, b| a.0.cmp(&b.0));
            confirmations += turn_events.len();
            fields.insert(
                "events".into(),
                Value::Array(turn_events.into_iter().map(|(_, event)| event).collect()),
            );
        }
    }
    Ok(Details {
        extras,
        summary: json!({
            "turns": shared_turns,
            "elapsedMs": elapsed,
            "models": used_models,
            "confirmations": confirmations,
        }),
    })
}

/// Latest task model per user message, from the main conversation only.
fn turn_models(
    state: &AppState,
    session_id: &str,
) -> Result<HashMap<String, (String, Option<String>)>, RpcError> {
    let mut models = HashMap::new();
    let mut before = None;
    loop {
        let page = state
            .store
            .model_calls_page(&ModelCallsParams {
                session_id: session_id.into(),
                agent_id: None,
                before,
                limit: 100,
            })
            .map_err(store_err)?;
        for call in page.calls {
            if call.agent_id.is_some() || call.trace.purpose != ModelCallPurpose::Task {
                continue;
            }
            if let (Some(source), Some(request)) = (call.source_message_id, call.request) {
                // Pages are newest first, so the first record per turn is the latest.
                models.entry(source).or_insert_with(|| {
                    let effort = request
                        .reasoning_effort
                        .and_then(|effort| serde_json::to_value(effort).ok())
                        .and_then(|value| value.as_str().map(str::to_owned));
                    (request.model, effort)
                });
            }
        }
        before = page.next_cursor;
        if before.is_none() {
            break;
        }
    }
    Ok(models)
}

fn questions(input: &Value, output: &Value) -> Vec<Value> {
    if let Some(items) = input["questions"].as_array() {
        return items
            .iter()
            .filter_map(|item| {
                let prompt = item["prompt"].as_str()?;
                Some(question(
                    prompt,
                    &item["options"],
                    &output["answers"][prompt],
                ))
            })
            .collect();
    }
    input["prompt"]
        .as_str()
        .map(|prompt| vec![question(prompt, &input["options"], &output["answer"])])
        .unwrap_or_default()
}

fn question(prompt: &str, options: &Value, answer: &Value) -> Value {
    let options: Vec<&str> = options
        .as_array()
        .map(|values| values.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let answer = match answer {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    json!({"type":"question","prompt":prompt,"options":options,"answer":answer})
}
