//! Shared daemon state passed to every connection and RPC handler.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use std::path::PathBuf;

use miniq_memory::Store;
use miniq_models::{ConfiguredProvider, ModelProvider, ProviderConfig};
use miniq_protocol::{Event, TurnPhase, TurnProgress};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot};
use tokio_util::sync::CancellationToken;

/// How risky (medium/high) tool calls are gated. Blocked calls are always
/// rejected regardless of mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalMode {
    /// Ask before every risky action, even ones already approved this session.
    AlwaysAsk,
    /// Ask for risky actions unless approved for this session (default).
    #[default]
    Auto,
    /// Never ask; every non-blocked action runs immediately.
    FullAccess,
}

/// Persisted daemon settings (data dir `settings.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSettings {
    #[serde(default)]
    pub provider: Option<ProviderConfig>,
    #[serde(default)]
    pub mcp_servers: Vec<crate::mcp::McpServerConfig>,
    #[serde(default)]
    pub approval_mode: ApprovalMode,
    #[serde(default)]
    pub remote_access: crate::remote::RemoteAccessSettings,
}

fn uuid_suffix() -> String {
    use rand::Rng;
    rand::rng()
        .sample_iter(&rand::distr::Alphanumeric)
        .take(12)
        .map(char::from)
        .collect()
}

impl DaemonSettings {
    pub fn load(path: &std::path::Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &std::path::Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)
    }
}

/// User decision on a pending approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approve,
    ApproveForSession,
    Reject,
}

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    /// Fixed provider used in tests; when `None` the provider is built from
    /// `settings` on each turn (so settings changes apply immediately).
    pub provider_override: Option<Arc<dyn ModelProvider>>,
    pub settings: Arc<Mutex<DaemonSettings>>,
    /// Where settings are persisted; `None` for in-memory (tests).
    pub settings_path: Option<Arc<PathBuf>>,
    pub router: Arc<miniq_tools::ToolRouter>,
    pub processes: Arc<miniq_tools::ProcessManager>,
    pub tasks: Arc<miniq_tools::TaskManager>,
    pub(crate) agent_tasks: Arc<crate::agent_tasks::AgentTaskManager>,
    pub plugins: Arc<miniq_plugins::PluginManager>,
    pub skills: Arc<miniq_skills::SkillStore>,
    pub events: broadcast::Sender<Event>,
    pub started: Instant,
    pub token: String,
    /// Cancels the listener and connected clients during an app update.
    pub shutdown: CancellationToken,
    /// Cancellation token per session with an active turn.
    pub active_turns: Arc<Mutex<HashMap<String, CancellationToken>>>,
    /// Pending approvals waiting for a user decision (approval id -> waker).
    pub pending_approvals: Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    /// Per-session allowlist of approved tool patterns ("approve for session").
    pub session_allowlist: Arc<Mutex<HashMap<String, HashSet<String>>>>,
    /// Pending ask_user questions (question id -> answer waker).
    pub pending_questions: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    /// Details retained so a reconnected UI can restore pending questions.
    pub pending_question_details: Arc<Mutex<HashMap<String, miniq_protocol::Question>>>,
    /// Latest published plan per session (in-memory; the plan is a live view).
    pub plans: Arc<Mutex<HashMap<String, Vec<miniq_protocol::PlanTask>>>>,
    /// In-progress assistant text retained across UI reconnects.
    pub streaming_texts: Arc<Mutex<HashMap<String, String>>>,
    /// Latest observable turn phase retained across UI reconnects.
    pub turn_progresses: Arc<Mutex<HashMap<String, TurnProgress>>>,
    /// Directory holding checkpoint file backups.
    pub checkpoints_dir: PathBuf,
    /// MCP connection manager (lazy per-server connections).
    pub mcp: Arc<crate::mcp::McpManager>,
    /// Observable state for the outbound encrypted relay connection.
    pub remote_status: Arc<Mutex<crate::remote::RemoteRuntimeStatus>>,
}

impl AppState {
    /// State with a fixed provider (tests). Skills live in a fresh temp dir.
    pub fn new(store: Store, token: String, provider: Arc<dyn ModelProvider>) -> Self {
        let skills_dir = std::env::temp_dir().join(format!("miniq-test-{}", uuid_suffix()));
        Self::build(
            store,
            token,
            Some(provider),
            DaemonSettings::default(),
            None,
            skills_dir,
        )
    }

    /// State whose provider follows persisted settings (production daemon).
    /// The skill store lives next to the settings file in the data dir.
    pub fn with_settings(
        store: Store,
        token: String,
        settings: DaemonSettings,
        settings_path: PathBuf,
    ) -> Self {
        let data_dir = settings_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        Self::build(store, token, None, settings, Some(settings_path), data_dir)
    }

    fn build(
        store: Store,
        token: String,
        provider_override: Option<Arc<dyn ModelProvider>>,
        settings: DaemonSettings,
        settings_path: Option<PathBuf>,
        data_dir: PathBuf,
    ) -> Self {
        let (events, _) = broadcast::channel(1024);
        let router = Arc::new(miniq_tools::default_router());
        let plugins = Arc::new(miniq_plugins::PluginManager::new(
            data_dir.join("plugins"),
            router.clone(),
            miniq_plugins::PluginLimits::default(),
        ));
        Self {
            store: Arc::new(store),
            provider_override,
            settings: Arc::new(Mutex::new(settings)),
            settings_path: settings_path.map(Arc::new),
            router,
            processes: Arc::new(miniq_tools::ProcessManager::default()),
            tasks: Arc::new(miniq_tools::TaskManager::default()),
            agent_tasks: Arc::new(crate::agent_tasks::AgentTaskManager::default()),
            plugins,
            skills: Arc::new(miniq_skills::SkillStore::new(
                &data_dir,
                miniq_skills::bundled_skills(),
            )),
            events,
            started: Instant::now(),
            token,
            shutdown: CancellationToken::new(),
            active_turns: Arc::new(Mutex::new(HashMap::new())),
            pending_approvals: Arc::new(Mutex::new(HashMap::new())),
            session_allowlist: Arc::new(Mutex::new(HashMap::new())),
            pending_questions: Arc::new(Mutex::new(HashMap::new())),
            pending_question_details: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            streaming_texts: Arc::new(Mutex::new(HashMap::new())),
            turn_progresses: Arc::new(Mutex::new(HashMap::new())),
            checkpoints_dir: data_dir.join("checkpoints"),
            mcp: crate::mcp::McpManager::new(),
            remote_status: Arc::new(Mutex::new(crate::remote::RemoteRuntimeStatus::default())),
        }
    }

    /// Bridge handed to tools so mcp_call can reach configured servers.
    pub fn mcp_bridge(&self) -> Option<Arc<dyn miniq_tools::McpBridge>> {
        let servers = self.settings.lock().unwrap().mcp_servers.clone();
        if servers.is_empty() {
            return None;
        }
        Some(Arc::new(crate::mcp::ManagerBridge {
            manager: self.mcp.clone(),
            servers,
        }))
    }

    /// Register a pending question and get the receiver the executor awaits.
    pub fn register_question(
        &self,
        question: &miniq_protocol::Question,
    ) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        self.pending_questions
            .lock()
            .unwrap()
            .insert(question.id.clone(), tx);
        self.pending_question_details
            .lock()
            .unwrap()
            .insert(question.id.clone(), question.clone());
        rx
    }

    pub fn finish_question(&self, question_id: &str) {
        self.pending_questions.lock().unwrap().remove(question_id);
        self.pending_question_details
            .lock()
            .unwrap()
            .remove(question_id);
    }

    pub fn pending_questions_for_session(&self, session_id: &str) -> Vec<miniq_protocol::Question> {
        let mut questions = self
            .pending_question_details
            .lock()
            .unwrap()
            .values()
            .filter(|question| question.session_id == session_id)
            .cloned()
            .collect::<Vec<_>>();
        questions.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        questions
    }

    pub fn append_streaming_text(&self, session_id: &str, delta: &str) {
        self.streaming_texts
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .push_str(delta);
    }

    pub fn streaming_text(&self, session_id: &str) -> String {
        self.streaming_texts
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn clear_streaming_text(&self, session_id: &str) {
        self.streaming_texts.lock().unwrap().remove(session_id);
    }

    pub fn set_turn_progress(&self, session_id: &str, phase: TurnPhase, model_step: Option<usize>) {
        let progress = TurnProgress {
            phase,
            model_step,
            started_at: miniq_memory::now_iso(),
        };
        self.turn_progresses
            .lock()
            .unwrap()
            .insert(session_id.to_string(), progress.clone());
        self.emit(Event::TurnProgressChanged {
            session_id: session_id.to_string(),
            progress,
        });
    }

    pub fn turn_progress(&self, session_id: &str) -> Option<TurnProgress> {
        self.turn_progresses
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
    }

    pub fn clear_turn_progress(&self, session_id: &str) {
        self.turn_progresses.lock().unwrap().remove(session_id);
    }

    /// Deliver an answer to a waiting ask_user call.
    pub fn deliver_answer(&self, question_id: &str, answer: String) -> bool {
        let sender = self.pending_questions.lock().unwrap().remove(question_id);
        match sender {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    /// Provider for the next turn: the test override, or one built from the
    /// current settings.
    pub fn current_provider(&self) -> Arc<dyn ModelProvider> {
        self.current_provider_for_model(None)
    }

    pub fn current_provider_for_model(&self, model: Option<&str>) -> Arc<dyn ModelProvider> {
        if let Some(provider) = &self.provider_override {
            return provider.clone();
        }
        let settings = self.settings.lock().unwrap();
        match &settings.provider {
            Some(config) => {
                let mut config = config.clone();
                if let Some(model) = model {
                    config.model = model.to_string();
                }
                Arc::new(ConfiguredProvider::new(config))
            }
            None => Arc::new(crate::UnconfiguredProvider),
        }
    }

    /// Apply and persist new settings.
    pub fn update_settings(&self, new_settings: DaemonSettings) -> Result<(), String> {
        if let Some(path) = &self.settings_path {
            new_settings.save(path).map_err(|e| e.to_string())?;
        }
        *self.settings.lock().unwrap() = new_settings;
        Ok(())
    }

    /// Register a pending approval and get the receiver the executor awaits.
    pub fn register_approval(&self, approval_id: &str) -> oneshot::Receiver<ApprovalDecision> {
        let (tx, rx) = oneshot::channel();
        self.pending_approvals
            .lock()
            .unwrap()
            .insert(approval_id.to_string(), tx);
        rx
    }

    /// Deliver a user decision to the waiting executor. Returns false if the
    /// approval is unknown or already resolved.
    pub fn deliver_approval(&self, approval_id: &str, decision: ApprovalDecision) -> bool {
        let sender = self.pending_approvals.lock().unwrap().remove(approval_id);
        match sender {
            Some(tx) => tx.send(decision).is_ok(),
            None => false,
        }
    }

    pub fn allow_for_session(&self, session_id: &str, pattern: &str) {
        self.session_allowlist
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .insert(pattern.to_string());
    }

    pub fn is_allowed_for_session(&self, session_id: &str, pattern: &str) -> bool {
        self.session_allowlist
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|set| set.contains(pattern))
    }

    /// Broadcast an event to all connected UIs. Errors (no receivers) are
    /// ignored: durable state is persisted in the store, events are a live
    /// view.
    pub fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }

    /// Register a new turn for a session. Different sessions may run in
    /// parallel, including sessions that share a workspace.
    pub fn begin_turn(&self, session_id: &str) -> Option<CancellationToken> {
        let mut turns = self.active_turns.lock().unwrap();
        if turns.contains_key(session_id) {
            return None;
        }
        let token = CancellationToken::new();
        turns.insert(session_id.to_string(), token.clone());
        Some(token)
    }

    pub fn end_turn(&self, session_id: &str) {
        self.active_turns.lock().unwrap().remove(session_id);
    }

    pub fn cancel_turn(&self, session_id: &str) -> bool {
        let turns = self.active_turns.lock().unwrap();
        match turns.get(session_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub fn cancel_all_turns(&self) -> usize {
        let turns = self.active_turns.lock().unwrap();
        for token in turns.values() {
            token.cancel();
        }
        turns.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_models::mock::MockProvider;

    #[test]
    fn streaming_text_survives_ui_reloads_until_turn_finishes() {
        let state = AppState::new(
            Store::open_in_memory().unwrap(),
            "token".to_string(),
            Arc::new(MockProvider::new(Vec::new())),
        );

        state.append_streaming_text("session", "前半段");
        state.append_streaming_text("session", "后半段");
        assert_eq!(state.streaming_text("session"), "前半段后半段");

        state.clear_streaming_text("session");
        assert_eq!(state.streaming_text("session"), "");
    }

    #[test]
    fn turn_progress_survives_ui_reloads_until_turn_finishes() {
        let state = AppState::new(
            Store::open_in_memory().unwrap(),
            "token".to_string(),
            Arc::new(MockProvider::new(Vec::new())),
        );

        state.set_turn_progress("session", TurnPhase::RequestingModel, Some(3));
        let progress = state.turn_progress("session").unwrap();
        assert_eq!(progress.phase, TurnPhase::RequestingModel);
        assert_eq!(progress.model_step, Some(3));

        state.clear_turn_progress("session");
        assert!(state.turn_progress("session").is_none());
    }
}
