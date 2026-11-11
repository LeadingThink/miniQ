//! Turn context assembly.
//!
//! One place decides which model-visible sections exist for a turn, in what
//! order, with what byte budget, and what they point at. Nothing else appends
//! strings to the runtime system message.

use std::path::Path;

use miniq_agent::{truncate_to_budget, ContextSource, ContextState, SectionFingerprint, SectionId};
use miniq_models::{ChatMessage, ChatRole};

use crate::instructions::{self, InstructionSettings};
use crate::state::AppState;

/// Budget for the session goal block.
const GOAL_BUDGET: usize = 4_096;
/// Budget for the session checklist block.
const PLAN_BUDGET: usize = 4_096;
/// Budget for the attached-roots block.
const ROOTS_BUDGET: usize = 2_048;
/// Budget for the memory-target routing hint.
const MEMORY_TARGET_BUDGET: usize = 1_024;

/// Everything one turn needs to describe its own context.
pub struct TurnContextInput<'a> {
    pub workspace_path: &'a Path,
    /// Ordered authorized roots: primary workspace first, then additional ones.
    pub roots: &'a [String],
    pub skills_block: &'a str,
    pub goal: Option<&'a str>,
    pub plan: &'a str,
    /// Workspace id plus the tooling hint that accompanies it.
    pub memory_target: Option<(&'a str, &'a str)>,
    pub external_paths_allowed: bool,
    pub side: bool,
}

/// Build the model-visible context for one turn.
pub fn build(state: &AppState, input: TurnContextInput<'_>) -> ContextState {
    let settings = instruction_settings(state);
    let mut context = ContextState::new();

    context.set(
        SectionId::Core,
        crate::system_prompt::build(input.workspace_path, &state.router.specs()),
    );
    context.set(
        SectionId::Runtime,
        crate::turn::runtime_context(input.workspace_path),
    );

    let loaded = instructions::load(input.workspace_path, &settings);
    context.set_with(
        SectionId::ProjectInstructions,
        loaded.text(),
        instruction_sources(&loaded, settings.max_bytes),
        loaded.files.iter().any(|file| file.truncated),
    );

    context.set(SectionId::HostFiles, crate::turn::HOST_APP_CONTEXT);

    if let Some(goal) = input.goal {
        let (body, truncated) = truncate_to_budget(SectionId::Goal, goal.to_string(), GOAL_BUDGET);
        context.set_with(SectionId::Goal, body, Vec::new(), truncated);
    }
    let (plan, plan_truncated) =
        truncate_to_budget(SectionId::Plan, input.plan.to_string(), PLAN_BUDGET);
    context.set_with(SectionId::Plan, plan, Vec::new(), plan_truncated);

    if let Some((target, hint)) = input.memory_target {
        let (body, truncated) = truncate_to_budget(
            SectionId::MemoryTarget,
            format!("{target}\n{hint}"),
            MEMORY_TARGET_BUDGET,
        );
        context.set_with(SectionId::MemoryTarget, body, Vec::new(), truncated);
    }

    let (roots, roots_truncated) = truncate_to_budget(
        SectionId::Roots,
        roots_block(
            input.roots,
            input.workspace_path,
            input.external_paths_allowed,
        ),
        ROOTS_BUDGET,
    );
    context.set_with(SectionId::Roots, roots, Vec::new(), roots_truncated);

    context.set(SectionId::Skills, input.skills_block);

    if input.side {
        context.set(SectionId::SidePolicy, crate::side_conversation::POLICY);
    }

    context
}

/// Render the context into the single leading system message.
pub fn history(
    context: &ContextState,
    previous: Option<&[SectionFingerprint]>,
    messages: &[miniq_protocol::Message],
    snapshot: Option<miniq_memory::ModelContextSnapshot>,
) -> Vec<ChatMessage> {
    let mut history = vec![ChatMessage::system(context.render_with_previous(previous))];
    history.extend(crate::turn::restore_conversation(messages, snapshot));
    history
}

/// Record this turn's section fingerprints for the next turn's diff.
pub fn persist(state: &AppState, session_id: &str, context: &ContextState) {
    let Ok(value) = serde_json::to_value(context.fingerprints()) else {
        return;
    };
    if let Err(error) = state.store.save_turn_context(session_id, &value) {
        tracing::warn!(session_id, %error, "failed to record turn context");
    }
}

/// Previously recorded fingerprints, tolerating an absent or legacy row.
pub fn previous(state: &AppState, session_id: &str) -> Option<Vec<SectionFingerprint>> {
    let snapshot = state.store.get_turn_context(session_id).ok().flatten()?;
    serde_json::from_value::<Vec<SectionFingerprint>>(snapshot.sections).ok()
}

/// Shorthand for the session's workspace + authorized roots.
pub fn roots_for(state: &AppState, workspace_id: &str) -> Result<Vec<String>, String> {
    let workspace = state
        .store
        .get_workspace(workspace_id)
        .map_err(|error| error.to_string())?;
    Ok(std::iter::once(workspace.path)
        .chain(workspace.additional_paths)
        .collect())
}

fn instruction_settings(state: &AppState) -> InstructionSettings {
    let configured = state.settings.lock().unwrap().instructions.clone();
    let mut settings = InstructionSettings::default();
    settings.enabled = configured.enabled;
    settings.max_bytes = configured.max_bytes;
    if !configured.filenames.is_empty() {
        settings.filenames = configured.filenames;
    }
    if !configured.project_root_markers.is_empty() {
        settings.project_root_markers = configured.project_root_markers;
    }
    settings
}

fn instruction_sources(
    loaded: &instructions::LoadedInstructions,
    max_bytes: usize,
) -> Vec<ContextSource> {
    let mut remaining = max_bytes;
    loaded
        .files
        .iter()
        .map(|file| {
            let budget_limited = file.truncated || file.original_bytes > remaining;
            remaining = remaining.saturating_sub(file.bytes());
            ContextSource::new(
                file.path.to_string_lossy(),
                file.original_bytes,
                budget_limited,
            )
        })
        .collect()
}

fn roots_block(roots: &[String], workspace_path: &Path, external_paths_allowed: bool) -> String {
    let scope = if external_paths_allowed {
        "Full Access is enabled for this session: absolute paths outside these roots are allowed \
         when the user explicitly names them."
    } else {
        "Only these attached roots are allowed; paths outside them must be attached before use."
    };
    format!(
        "Attached project directories (authorized roots): {}. Relative tool paths resolve from \
         '{}'; use absolute paths for the other attached directories. Existing sessions keep \
         their working directory when the project primary changes. {}",
        serde_json::to_string(roots).unwrap_or_else(|_| "[]".to_string()),
        workspace_path.display(),
        scope
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use miniq_models::{
        ChatDelta, CompletionRequest, DeltaStream, ModelCapabilities, ModelProvider,
    };

    struct NullProvider;

    #[async_trait::async_trait]
    impl ModelProvider for NullProvider {
        async fn stream_complete(
            &self,
            _request: CompletionRequest,
        ) -> Result<DeltaStream, miniq_models::ProviderError> {
            Ok(Box::pin(futures_util::stream::iter(Vec::<
                Result<ChatDelta, miniq_models::ProviderError>,
            >::new())))
        }
        async fn capabilities(&self) -> ModelCapabilities {
            ModelCapabilities::default()
        }
        fn describe(&self) -> String {
            "null".to_string()
        }
    }

    fn state() -> AppState {
        AppState::new(
            miniq_memory::Store::open_in_memory().unwrap(),
            "token".into(),
            std::sync::Arc::new(NullProvider),
        )
    }

    fn input<'a>(workspace: &'a Path, roots: &'a [String]) -> TurnContextInput<'a> {
        TurnContextInput {
            workspace_path: workspace,
            roots,
            skills_block: "",
            goal: None,
            plan: "",
            memory_target: None,
            external_paths_allowed: false,
            side: false,
        }
    }

    #[test]
    fn project_instructions_are_read_from_the_workspace() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".git")).unwrap();
        std::fs::write(temp.path().join("AGENTS.md"), "Use pnpm, never npm.").unwrap();
        let state = state();
        let roots = vec![temp.path().to_string_lossy().into_owned()];
        let context = build(&state, input(temp.path(), &roots));
        let rendered = context.render();
        assert!(rendered.contains("Use pnpm, never npm."));
        assert!(rendered.contains("section=\"project_instructions\""));
        assert_eq!(context.sources().len(), 1);
        assert!(context.sources()[0].path.ends_with("AGENTS.md"));
    }

    #[test]
    fn absent_instructions_add_no_section() {
        let temp = tempfile::tempdir().unwrap();
        let state = state();
        let roots = vec![temp.path().to_string_lossy().into_owned()];
        let context = build(&state, input(temp.path(), &roots));
        assert!(!context.contains(SectionId::ProjectInstructions));
        assert!(!context.render().contains("project_instructions"));
    }

    #[test]
    fn disabling_instructions_in_settings_skips_discovery() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("AGENTS.md"), "Use pnpm.").unwrap();
        let state = state();
        {
            let mut settings = state.settings.lock().unwrap().clone();
            settings.instructions.enabled = false;
            *state.settings.lock().unwrap() = settings;
        }
        let roots = vec![temp.path().to_string_lossy().into_owned()];
        let context = build(&state, input(temp.path(), &roots));
        assert!(!context.contains(SectionId::ProjectInstructions));
    }

    #[test]
    fn base_prompt_is_miniq_without_the_retired_execution_policy() {
        let temp = tempfile::tempdir().unwrap();
        let state = state();
        let roots = vec![temp.path().to_string_lossy().into_owned()];
        let context = build(&state, input(temp.path(), &roots));
        assert!(context
            .get(SectionId::Core)
            .unwrap()
            .body()
            .starts_with("You are an AI coworker running inside miniQ,"));
        assert!(!context.contains(SectionId::ExecutionPolicy));
    }

    #[test]
    fn sections_render_in_a_stable_order() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("AGENTS.md"), "PROJECT RULE").unwrap();
        let state = state();
        let roots = vec![temp.path().to_string_lossy().into_owned()];
        let mut input = input(temp.path(), &roots);
        input.skills_block = "SKILL BLOCK";
        let context = build(&state, input);
        let rendered = context.render();
        let runtime = rendered.find("Runtime environment:").unwrap();
        let project = rendered.find("PROJECT RULE").unwrap();
        let host = rendered.find("Host app file references:").unwrap();
        let skills = rendered.find("SKILL BLOCK").unwrap();
        assert!(runtime < project);
        assert!(project < host);
        assert!(host < skills);
    }

    #[test]
    fn side_policy_is_appended_only_for_side_conversations() {
        let temp = tempfile::tempdir().unwrap();
        let state = state();
        let roots = vec![temp.path().to_string_lossy().into_owned()];
        let parent = build(&state, input(temp.path(), &roots));
        assert!(!parent.render().contains("You are in a side conversation"));

        let mut side_input = input(temp.path(), &roots);
        side_input.side = true;
        let side = build(&state, side_input);
        assert!(side.render().contains("You are in a side conversation"));
    }

    #[test]
    fn oversized_instructions_are_truncated_with_a_marker() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("AGENTS.md"), "a".repeat(2048)).unwrap();
        let state = state();
        {
            let mut settings = state.settings.lock().unwrap().clone();
            settings.instructions.max_bytes = 256;
            *state.settings.lock().unwrap() = settings;
        }
        let roots = vec![temp.path().to_string_lossy().into_owned()];
        let context = build(&state, input(temp.path(), &roots));
        let section = context.get(SectionId::ProjectInstructions).unwrap();
        assert!(section.is_truncated());
        assert!(section.body().contains("exceeded its 256 byte budget"));
    }

    #[test]
    fn fingerprints_track_content_changes() {
        let temp = tempfile::tempdir().unwrap();
        let state = state();
        let roots = vec![temp.path().to_string_lossy().into_owned()];

        std::fs::write(temp.path().join("AGENTS.md"), "alpha").unwrap();
        let first = build(&state, input(temp.path(), &roots)).fingerprints();

        std::fs::write(temp.path().join("AGENTS.md"), "beta").unwrap();
        let second = build(&state, input(temp.path(), &roots));
        let rendered = second.render_with_previous(Some(&first));
        assert!(rendered.contains("This replaces the previously provided project_instructions"));

        let third = build(&state, input(temp.path(), &roots))
            .render_with_previous(Some(&second.fingerprints()));
        assert!(!third.contains("This replaces the previously provided"));
    }

    #[test]
    fn removed_instructions_notify_the_model() {
        let temp = tempfile::tempdir().unwrap();
        let state = state();
        let roots = vec![temp.path().to_string_lossy().into_owned()];

        let instructions = temp.path().join("AGENTS.md");
        std::fs::write(&instructions, "temporary rule").unwrap();
        let first = build(&state, input(temp.path(), &roots)).fingerprints();

        std::fs::remove_file(&instructions).unwrap();
        let second = build(&state, input(temp.path(), &roots));
        let rendered = second.render_with_previous(Some(&first));
        assert!(rendered.contains("no longer applies"));
    }

    #[test]
    fn persisted_fingerprints_round_trip_through_the_store() {
        let temp = tempfile::tempdir().unwrap();
        let state = state();
        let workspace = state.store.create_workspace("/tmp/ws", "ws").unwrap();
        let session = state.store.create_session(&workspace.id, "title").unwrap();
        std::fs::write(temp.path().join("AGENTS.md"), "persisted rule").unwrap();
        let roots = vec![temp.path().to_string_lossy().into_owned()];

        let context = build(&state, input(temp.path(), &roots));
        persist(&state, &session.id, &context);
        let restored = previous(&state, &session.id).expect("recorded");
        assert_eq!(restored.len(), context.fingerprints().len());
        assert!(restored
            .iter()
            .any(|entry| entry.id == "project_instructions"));
    }

    #[test]
    fn goal_and_plan_stay_out_of_the_project_section() {
        let temp = tempfile::tempdir().unwrap();
        let state = state();
        let roots = vec![temp.path().to_string_lossy().into_owned()];
        let mut input = input(temp.path(), &roots);
        input.goal = Some("Ship the migration");
        input.plan = "[{\"content\":\"step one\",\"status\":\"pending\"}]";
        let rendered = build(&state, input).render();
        assert!(rendered.contains("Ship the migration"));
        assert!(rendered.contains("step one"));
        let goal = rendered.find("Ship the migration").unwrap();
        let plan = rendered.find("step one").unwrap();
        assert!(goal < plan);
    }

    #[test]
    fn history_returns_exactly_one_leading_system_message() {
        let temp = tempfile::tempdir().unwrap();
        let state = state();
        let roots = vec![temp.path().to_string_lossy().into_owned()];
        let context = build(&state, input(temp.path(), &roots));
        let history = history(&context, None, &[], None);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].role, ChatRole::System);
    }

    #[test]
    fn roots_cover_the_primary_workspace_first() {
        let state = state();
        let workspace = state.store.create_workspace("/tmp/primary", "ws").unwrap();
        state
            .store
            .update_workspace_roots(&workspace.id, "/tmp/primary", &["/tmp/extra".to_string()])
            .unwrap();
        let roots = roots_for(&state, &workspace.id).unwrap();
        assert_eq!(
            roots,
            vec!["/tmp/primary".to_string(), "/tmp/extra".to_string()]
        );
    }
}
