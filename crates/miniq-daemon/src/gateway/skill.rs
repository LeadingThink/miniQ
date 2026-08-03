use std::path::PathBuf;

use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeParams {
    #[serde(default)]
    workspace_id: Option<String>,
}

pub(super) fn list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ScopeParams = params(raw)?;
    let workspace = workspace_path(state, input.workspace_id.as_deref())?;
    let skills = state.skills.discover(workspace.as_deref());
    to_value(json!({ "skills": skills }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadParams {
    name: String,
    #[serde(default)]
    workspace_id: Option<String>,
}

pub(super) fn read(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ReadParams = params(raw)?;
    let workspace = workspace_path(state, input.workspace_id.as_deref())?;
    let detail = state
        .skills
        .read(workspace.as_deref(), &input.name)
        .map_err(skill_err)?;
    to_value(detail)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetEnabledParams {
    name: String,
    enabled: bool,
}

pub(super) fn set_enabled(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SetEnabledParams = params(raw)?;
    state
        .skills
        .set_enabled(&input.name, input.enabled)
        .map_err(skill_err)?;
    Ok(json!({ "name": input.name, "enabled": input.enabled }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteParams {
    name: String,
    #[serde(default)]
    workspace_id: Option<String>,
}

pub(super) fn delete(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: DeleteParams = params(raw)?;
    let workspace = workspace_path(state, input.workspace_id.as_deref())?;
    state
        .skills
        .delete(workspace.as_deref(), &input.name)
        .map_err(skill_err)?;
    Ok(json!({ "deleted": input.name }))
}

fn workspace_path(
    state: &AppState,
    workspace_id: Option<&str>,
) -> Result<Option<PathBuf>, RpcError> {
    match workspace_id {
        Some(id) => {
            let workspace = state.store.get_workspace(id).map_err(store_err)?;
            Ok(Some(PathBuf::from(workspace.path)))
        }
        None => Ok(None),
    }
}

fn skill_err(error: miniq_skills::StoreError) -> RpcError {
    match &error {
        miniq_skills::StoreError::NotFound(_) => {
            RpcError::new(ErrorCode::InvalidParams, error.to_string())
        }
        _ => RpcError::new(ErrorCode::InternalError, error.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DistillParams {
    session_id: String,
}

pub(super) async fn distill(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: DistillParams = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    if !crate::learn::has_completed_turn(state, &input.session_id) {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "session has no completed turn to distill",
        ));
    }

    let transcript = transcript(state, &input.session_id)?;
    let existing = existing_skill_names(state);
    let inference = crate::learn::ProviderInference {
        provider: state.current_provider(),
    };
    let outcome = miniq_skills::distill_skill(&transcript, &existing, &inference)
        .await
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))?;
    distill_value(outcome, &existing)
}

fn distill_value(
    outcome: miniq_skills::DistillOutcome,
    existing: &[String],
) -> Result<Value, RpcError> {
    match outcome {
        miniq_skills::DistillOutcome::Skipped { reason } => {
            Ok(json!({ "skipped": true, "reason": reason }))
        }
        miniq_skills::DistillOutcome::Draft {
            content,
            name,
            description,
            warnings,
        } => {
            let existing_skill = existing.contains(&name);
            Ok(json!({
                "skipped": false,
                "content": content,
                "name": name,
                "description": description,
                "warnings": warnings,
                "existingSkill": existing_skill,
            }))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefineParams {
    session_id: String,
    name: String,
}

pub(super) async fn refine(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: RefineParams = params(raw)?;
    let detail = state.skills.read(None, &input.name).map_err(skill_err)?;
    let existing_markdown = miniq_skills::render_skill_md(&detail.skill.meta, &detail.body);
    let transcript = transcript(state, &input.session_id)?;
    let inference = crate::learn::ProviderInference {
        provider: state.current_provider(),
    };
    let outcome = miniq_skills::refine_skill(&existing_markdown, &transcript, &inference)
        .await
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))?;
    Ok(match outcome {
        miniq_skills::RefineOutcome::Kept => json!({ "kept": true }),
        miniq_skills::RefineOutcome::Updated { content, warnings } => json!({
            "kept": false,
            "content": content,
            "warnings": warnings,
        }),
    })
}

fn transcript(state: &AppState, session_id: &str) -> Result<String, RpcError> {
    crate::learn::build_transcript(state, session_id)
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error))
}

fn existing_skill_names(state: &AppState) -> Vec<String> {
    state
        .skills
        .discover(None)
        .into_iter()
        .map(|skill| skill.meta.name)
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveParams {
    content: String,
    #[serde(default)]
    force: bool,
}

pub(super) fn save(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SaveParams = params(raw)?;
    let warnings = miniq_skills::scan_sensitive(&input.content);
    if !warnings.is_empty() && !input.force {
        let mut error = RpcError::new(
            ErrorCode::InvalidParams,
            "draft contains possibly sensitive content; edit it or pass force=true",
        );
        error.data = Some(json!({ "warnings": warnings }));
        return Err(error);
    }

    let metadata = state.skills.save(&input.content).map_err(skill_err)?;
    let _ = state.store.append_audit_event(
        None,
        "skill_saved",
        &json!({"name": metadata.name, "version": metadata.version}),
    );
    to_value(json!({ "name": metadata.name, "version": metadata.version }))
}
