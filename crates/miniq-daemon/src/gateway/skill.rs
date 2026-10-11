use std::path::PathBuf;

use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportParams {
    path: String,
}

/// Import a versioned skill directory/package. The store validates every
/// SKILL.md and replaces same-name user skills, making local updates safe and
/// repeatable without touching project or bundled skills.
pub(super) fn import(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ImportParams = params(raw)?;
    let imported = state
        .skills
        .import_directory(Path::new(&input.path))
        .map_err(skill_err)?;
    let skills = state.skills.discover(None);
    to_value(json!({ "imported": imported, "skills": skills }))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    goal: String,
    #[serde(default)]
    name: Option<String>,
}

/// Draft a new skill from a plain-language goal. Nothing is installed until
/// the user reviews the draft and calls `skill.save`.
pub(super) async fn create(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: CreateParams = params(raw)?;
    let goal = input.goal.trim();
    if goal.chars().count() < 4 {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "describe what the skill should do",
        ));
    }
    if goal.chars().count() > 8000 {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "skill description is too long",
        ));
    }
    let existing = existing_skill_names(state);
    let inference = crate::learn::ProviderInference {
        provider: state.current_provider(),
    };
    let created = miniq_skills::create_skill(goal, input.name.as_deref(), &existing, &inference)
        .await
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))?;
    let validation = validate_with_models(state, &created.content, &existing).await;
    to_value(json!({
        "content": created.content,
        "name": created.name,
        "description": created.description,
        "validation": validation,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateParams {
    content: String,
}

pub(super) async fn validate(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ValidateParams = params(raw)?;
    let existing = existing_skill_names(state);
    to_value(validate_with_models(state, &input.content, &existing).await)
}

/// Structural checks plus a catalog check for every model a role declares.
async fn validate_with_models(
    state: &AppState,
    content: &str,
    existing: &[String],
) -> miniq_skills::SkillValidation {
    use miniq_skills::{CheckLevel, SkillCheck};
    let mut validation = miniq_skills::validate_skill(content, existing);
    let Ok((meta, _)) = miniq_skills::parse_skill_md(content) else {
        return validation;
    };
    let models: Vec<(String, String)> = meta
        .agents
        .iter()
        .filter_map(|agent| Some((agent.role.clone(), agent.model.clone()?)))
        .collect();
    if models.is_empty() {
        return validation;
    }
    let provider = state.settings.lock().unwrap().provider.clone();
    let catalog = match provider {
        Some(config) => crate::model_resolution::chat_models(&config).await,
        None => None,
    };
    let Some(catalog) = catalog else {
        validation.checks.push(SkillCheck {
            id: "agent-models",
            level: CheckLevel::Warning,
            message: "无法读取模型目录，未核对子任务模型；运行时会再次校验".into(),
        });
        return validation;
    };
    for (role, model) in models {
        let (level, message) = match crate::model_resolution::resolve(&model, &catalog) {
            crate::model_resolution::Resolution::Resolved(id) if id == model => {
                (CheckLevel::Ok, format!("{role}：模型 {model} 可用"))
            }
            crate::model_resolution::Resolution::Resolved(id) => (
                CheckLevel::Warning,
                format!("{role}：“{model}”将解析为 {id}，建议直接写精确 ID"),
            ),
            crate::model_resolution::Resolution::Ambiguous(ids) => (
                CheckLevel::Warning,
                format!(
                    "{role}：“{model}”对应多个模型（{}），请选一个",
                    ids.join("、")
                ),
            ),
            crate::model_resolution::Resolution::NotFound(ids) => (
                CheckLevel::Warning,
                if ids.is_empty() {
                    format!("{role}：模型目录中没有“{model}”")
                } else {
                    format!(
                        "{role}：模型目录中没有“{model}”，接近的有 {}",
                        ids.join("、")
                    )
                },
            ),
        };
        validation.checks.push(SkillCheck {
            id: "agent-models",
            level,
            message,
        });
    }
    validation
}
