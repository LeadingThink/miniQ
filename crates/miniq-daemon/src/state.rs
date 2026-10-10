//! Shared daemon state passed to every connection and RPC handler.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use std::path::PathBuf;

use miniq_memory::Store;
use miniq_models::{ModelProvider, ProviderConfig};
use miniq_protocol::{Event, TurnPhase, TurnProgress};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot};
use tokio_util::sync::CancellationToken;

pub use miniq_protocol::ApprovalMode;

pub(crate) struct ActiveTurn {
    cancellation: CancellationToken,
    _activity: crate::activity::ActivityGuard,
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
    /// Optional local command run after each turn. Empty means disabled.
    #[serde(default)]
    pub turn_ended_command: Option<String>,
    /// User lifecycle hooks (`preToolUse`, `stop`, ...), run in order.
    #[serde(default)]
    pub hooks: Vec<crate::hooks::HookConfig>,
    /// Staged feature flags (plan §4.7). Missing section keeps defaults.
    #[serde(default)]
    pub features: crate::features::FeatureFlags,
}

/// Why `settings.json` could not be used at startup (plan §4.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadError {
    pub path: String,
    pub error: String,
    /// Copy of the unreadable original. When `None` the copy failed and the
    /// daemon refuses every save so the original is never overwritten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
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
        Self::load_checked(path).0
    }

    /// Load settings; a present but unreadable/unparsable file degrades to
    /// defaults, is copied to `backups/settings.json.corrupt-<unix>` and is
    /// reported instead of being silently replaced.
    pub fn load_checked(path: &std::path::Path) -> (Self, Option<SettingsLoadError>) {
        let raw = match std::fs::read(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return (Self::default(), None)
            }
            Err(error) => {
                // Unreadable: we cannot copy it either, so block saves.
                let failure = SettingsLoadError {
                    path: path.display().to_string(),
                    error: error.to_string(),
                    backup_path: None,
                };
                tracing::error!(path = %failure.path, error = %failure.error, "settings file unreadable; saves disabled");
                return (Self::default(), Some(failure));
            }
        };
        let parsed = std::str::from_utf8(&raw)
            .map_err(|error| error.to_string())
            .and_then(|text| serde_json::from_str::<Self>(text).map_err(|e| e.to_string()));
        match parsed {
            Ok(settings) => (settings, None),
            Err(error) => {
                let backup_path = backup_corrupt(path, &raw);
                let failure = SettingsLoadError {
                    path: path.display().to_string(),
                    error,
                    backup_path: backup_path.map(|p| p.display().to_string()),
                };
                tracing::error!(
                    path = %failure.path,
                    error = %failure.error,
                    backup = ?failure.backup_path,
                    "settings file is corrupt; starting with defaults"
                );
                (Self::default(), Some(failure))
            }
        }
    }

    pub fn save(&self, path: &std::path::Path) -> std::io::Result<()> {
        miniq_local::write_private_json(path, self)
    }
}

/// `<data_dir>/backups` next to `settings.json`.
pub fn settings_backup_dir(settings_path: &std::path::Path) -> PathBuf {
    settings_path
        .parent()
        .map(|dir| dir.join("backups"))
        .unwrap_or_else(|| PathBuf::from("backups"))
}

/// Last known-good copy kept before each successful save.
pub fn settings_last_backup(settings_path: &std::path::Path) -> PathBuf {
    settings_backup_dir(settings_path).join("settings.json.bak")
}

fn backup_corrupt(path: &std::path::Path, raw: &[u8]) -> Option<PathBuf> {
    let dir = settings_backup_dir(path);
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let mut target = dir.join(format!("settings.json.corrupt-{unix}"));
    let mut n = 1;
    while target.exists() {
        target = dir.join(format!("settings.json.corrupt-{unix}-{n}"));
        n += 1;
    }
    let result = miniq_local::write_private_bytes(&target, raw);
    match result {
        Ok(()) => Some(target),
        Err(error) => {
            tracing::error!(%error, "failed to back up corrupt settings file");
            None
        }
    }
}

/// User decision on a pending approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approve,
    ApproveForSession,
    AlwaysAllowTool,
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
    /// Startup settings failure; while set with no backup, saves are refused.
    pub settings_load_error: Arc<Mutex<Option<SettingsLoadError>>>,
    pub router: Arc<miniq_tools::ToolRouter>,
    pub processes: Arc<miniq_tools::ProcessManager>,
    pub tasks: Arc<miniq_tools::TaskManager>,
    pub(crate) agent_tasks: Arc<crate::agent_tasks::AgentTaskManager>,
    pub plugins: Arc<miniq_plugins::PluginManager>,
    pub skills: Arc<miniq_skills::SkillStore>,
    pub events: broadcast::Sender<Event>,
    pub(crate) live_events: broadcast::Sender<Arc<crate::event_journal::LiveEvent>>,
    pub(crate) event_journal: Arc<Mutex<crate::event_journal::EventJournal>>,
    pub started: Instant,
    pub token: String,
    /// Cancels the listener and connected clients during an app update.
    pub shutdown: CancellationToken,
    /// Saved SSH hosts and independent daemon-owned connections.
    pub ssh_hosts: Arc<crate::ssh::SshHostManager>,
    /// Cancellation token per session with an active turn.
    pub(crate) active_turns: Arc<Mutex<HashMap<String, ActiveTurn>>>,
    pub(crate) review_jobs: Arc<Mutex<HashMap<String, CancellationToken>>>,
    /// Sessions whose active turn was interrupted for a user-requested pause.
    pub(crate) paused_turns: Arc<Mutex<HashSet<String>>>,
    /// One-shot model-step budgets requested by `session.sendMessage`
    /// (`maxTurns`). Consumed by the next turn of that session.
    pub(crate) turn_step_limits: Arc<Mutex<HashMap<String, usize>>>,
    /// Resume requests received while the paused turn is still cleaning up.
    pub(crate) pending_turn_resumes: Arc<Mutex<HashSet<String>>>,
    pub(crate) activity: crate::activity::ActivityGate,
    /// Bound snapshot hashing and uploads across desktop and mobile connections.
    pub(crate) share_uploads: Arc<tokio::sync::Semaphore>,
    pub(crate) title_jobs: Arc<Mutex<HashSet<String>>>,
    pub(crate) external_import_jobs: Arc<crate::external_import_jobs::ExternalImportJobs>,
    pub(crate) external_scan_jobs: Arc<crate::external_scan_jobs::ExternalScanJobs>,
    /// Pending approvals waiting for a user decision (approval id -> waker).
    pub pending_approvals: Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    /// Per-session allowlist of approved tool patterns ("approve for session").
    pub session_allowlist: Arc<Mutex<HashMap<String, HashSet<String>>>>,
    /// Pending ask_user questions (question id -> answer waker).
    pub pending_questions: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    /// Browser requests waiting for the active miniQ client WebView driver.
    pub pending_browser_requests: Arc<
        Mutex<
            HashMap<String, oneshot::Sender<Result<miniq_protocol::BrowserDriverResult, String>>>,
        >,
    >,
    /// Details retained so a reconnected UI can restore pending questions.
    pub pending_question_details: Arc<Mutex<HashMap<String, miniq_protocol::Question>>>,
    /// In-progress assistant text retained across UI reconnects.
    pub streaming_texts: Arc<Mutex<HashMap<String, String>>>,
    /// Latest observable turn phase retained across UI reconnects.
    pub turn_progresses: Arc<Mutex<HashMap<String, TurnProgress>>>,
    /// Directory holding checkpoint file backups.
    pub checkpoints_dir: PathBuf,
    pub observations_dir: PathBuf,
    /// MCP connection manager (lazy per-server connections).
    pub mcp: Arc<crate::mcp::McpManager>,
    /// Observable state for the outbound encrypted relay connection.
    pub remote_status: Arc<Mutex<crate::remote::RemoteRuntimeStatus>>,
    /// Persistent "always allow" rules (`<data_dir>/approvals/rules.json`).
    pub approval_rules: Arc<crate::approval_rules::ApprovalRules>,
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
        let store = Arc::new(store);
        let agent_tasks = Arc::new(crate::agent_tasks::AgentTaskManager::new(store.clone()));
        let shutdown = CancellationToken::new();
        let ssh_hosts = Arc::new(crate::ssh::SshHostManager::new(&data_dir, shutdown.clone()));
        Self {
            store,
            provider_override,
            settings: Arc::new(Mutex::new(settings)),
            settings_path: settings_path.map(Arc::new),
            settings_load_error: Arc::new(Mutex::new(None)),
            router,
            processes: Arc::new(miniq_tools::ProcessManager::default()),
            tasks: Arc::new(miniq_tools::TaskManager::default()),
            agent_tasks,
            plugins,
            skills: Arc::new(miniq_skills::SkillStore::new(
                &data_dir,
                miniq_skills::bundled_skills(),
            )),
            events,
            live_events: broadcast::channel(1024).0,
            event_journal: Arc::new(Mutex::new(crate::event_journal::EventJournal::default())),
            started: Instant::now(),
            token,
            shutdown,
            ssh_hosts,
            active_turns: Arc::new(Mutex::new(HashMap::new())),
            review_jobs: Arc::new(Mutex::new(HashMap::new())),
            paused_turns: Arc::new(Mutex::new(HashSet::new())),
            turn_step_limits: Arc::new(Mutex::new(HashMap::new())),
            pending_turn_resumes: Arc::new(Mutex::new(HashSet::new())),
            activity: crate::activity::ActivityGate::default(),
            share_uploads: Arc::new(tokio::sync::Semaphore::new(2)),
            title_jobs: Arc::new(Mutex::new(HashSet::new())),
            external_import_jobs: Arc::new(
                crate::external_import_jobs::ExternalImportJobs::default(),
            ),
            external_scan_jobs: Arc::new(crate::external_scan_jobs::ExternalScanJobs::default()),
            pending_approvals: Arc::new(Mutex::new(HashMap::new())),
            session_allowlist: Arc::new(Mutex::new(HashMap::new())),
            pending_questions: Arc::new(Mutex::new(HashMap::new())),
            pending_browser_requests: Arc::new(Mutex::new(HashMap::new())),
            pending_question_details: Arc::new(Mutex::new(HashMap::new())),
            streaming_texts: Arc::new(Mutex::new(HashMap::new())),
            turn_progresses: Arc::new(Mutex::new(HashMap::new())),
            checkpoints_dir: data_dir.join("checkpoints"),
            observations_dir: data_dir.join("observations"),
            mcp: crate::mcp::McpManager::new(),
            remote_status: Arc::new(Mutex::new(crate::remote::RemoteRuntimeStatus::default())),
            approval_rules: Arc::new(crate::approval_rules::ApprovalRules::new(Some(&data_dir))),
        }
    }

    /// MCP servers contributed by enabled plugins, with `env` resolved from
    /// the daemon's own environment.
    pub fn plugin_mcp_servers(&self) -> Vec<crate::mcp::PluginMcpServerConfig> {
        crate::mcp::resolve_plugin_servers(self.plugins.enabled_mcp_servers(), |name| {
            std::env::var(name).ok()
        })
    }

    /// User-configured servers plus plugin servers (settings win on name
    /// collisions). Read on every use, so plugin enable/disable/install/
    /// uninstall takes effect on the next turn without a restart.
    pub fn effective_mcp_servers(&self) -> Vec<crate::mcp::McpServerConfig> {
        let settings = self.settings.lock().unwrap().mcp_servers.clone();
        crate::mcp::merge_servers(&settings, &self.plugin_mcp_servers())
    }

    /// Bridge handed to tools so mcp_call can reach configured servers.
    pub fn mcp_bridge(&self) -> Option<Arc<dyn miniq_tools::McpBridge>> {
        let servers = self.effective_mcp_servers();
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

    pub fn register_browser_request(
        &self,
        request_id: &str,
    ) -> oneshot::Receiver<Result<miniq_protocol::BrowserDriverResult, String>> {
        let (sender, receiver) = oneshot::channel();
        self.pending_browser_requests
            .lock()
            .unwrap()
            .insert(request_id.to_string(), sender);
        receiver
    }

    pub fn finish_browser_request(&self, request_id: &str) {
        self.pending_browser_requests
            .lock()
            .unwrap()
            .remove(request_id);
    }

    pub fn deliver_browser_result(
        &self,
        resolution: miniq_protocol::BrowserDriverResolution,
    ) -> bool {
        let result = match (resolution.result, resolution.error) {
            (Some(result), None) => Ok(result),
            (None, Some(error)) if !error.trim().is_empty() => Err(error),
            _ => return false,
        };
        let sender = self
            .pending_browser_requests
            .lock()
            .unwrap()
            .remove(&resolution.request_id);
        sender.is_some_and(|sender| sender.send(result).is_ok())
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

    pub fn replace_streaming_text(&self, session_id: &str, text: &str) {
        self.streaming_texts
            .lock()
            .unwrap()
            .insert(session_id.to_string(), text.to_string());
    }

    pub fn set_turn_progress(&self, session_id: &str, phase: TurnPhase, model_step: Option<usize>) {
        let progress = TurnProgress {
            phase,
            model_step,
            started_at: miniq_memory::now_iso(),
            retry: None,
        };
        self.update_turn_progress(session_id, progress);
    }

    pub(crate) fn update_turn_progress(&self, session_id: &str, progress: TurnProgress) {
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
        self.provider_from_config(self.settings.lock().unwrap().provider.clone())
    }

    /// Apply and persist new settings.
    pub fn update_settings(&self, new_settings: DaemonSettings) -> Result<(), String> {
        if let Some(path) = &self.settings_path {
            let degraded = self.settings_load_error.lock().unwrap().clone();
            match &degraded {
                Some(failure) if failure.backup_path.is_none() => {
                    return Err(format!(
                        "settings file {} could not be loaded or backed up; refusing to overwrite it",
                        failure.path
                    ));
                }
                // The corrupt original is already backed up; keep the last
                // good `.bak` instead of replacing it with corrupt content.
                Some(_) => {}
                None => backup_before_save(path)?,
            }
            new_settings.save(path).map_err(|e| e.to_string())?;
        }
        *self.settings.lock().unwrap() = new_settings;
        Ok(())
    }

    /// Record a startup load failure and announce it to connected clients.
    pub fn report_settings_load_error(&self, failure: SettingsLoadError) {
        *self.settings_load_error.lock().unwrap() = Some(failure.clone());
        self.emit(Event::SettingsLoadFailed {
            path: failure.path,
            error: failure.error,
            backup_path: failure.backup_path,
        });
    }

    /// Replace `settings.json` with the last good `.bak` copy.
    pub fn restore_settings_backup(&self) -> Result<(), String> {
        let path = self
            .settings_path
            .as_ref()
            .ok_or_else(|| "settings are not persisted".to_string())?;
        let backup = settings_last_backup(path);
        let raw = std::fs::read_to_string(&backup)
            .map_err(|error| format!("no settings backup at {}: {error}", backup.display()))?;
        let restored: DaemonSettings = serde_json::from_str(&raw)
            .map_err(|error| format!("settings backup is invalid: {error}"))?;
        let degraded = self.settings_load_error.lock().unwrap().clone();
        match degraded {
            Some(failure) if failure.backup_path.is_none() => {
                return Err(format!(
                    "settings file {} was not backed up; refusing to overwrite it",
                    failure.path
                ));
            }
            Some(_) => {}
            // Swap: the current good file becomes the new `.bak`.
            None => {
                let current = std::fs::read(path.as_ref()).ok();
                restored.save(path).map_err(|e| e.to_string())?;
                if let Some(current) = current {
                    let _ = miniq_local::write_private_bytes(&backup, &current);
                }
                *self.settings.lock().unwrap() = restored;
                return Ok(());
            }
        }
        restored.save(path).map_err(|e| e.to_string())?;
        *self.settings.lock().unwrap() = restored;
        *self.settings_load_error.lock().unwrap() = None;
        Ok(())
    }

    /// Run the user-configured local completion hook without blocking the
    /// turn. Environment values are passed explicitly; no model or message
    /// content is interpolated into a shell command.
    pub fn run_turn_ended_hook(&self, session_id: &str, status: &str) {
        let command = self
            .settings
            .lock()
            .unwrap()
            .turn_ended_command
            .clone()
            .filter(|command| !command.trim().is_empty());
        let Some(command) = command else { return };
        let Ok(session) = self.store.get_session(session_id) else {
            return;
        };
        let Ok(workspace) = self.store.get_workspace(&session.workspace_id) else {
            return;
        };
        let session_id = session.id;
        let workspace_path = workspace.path;
        let title = session.title;
        let status = status.to_string();
        tokio::spawn(async move {
            #[cfg(windows)]
            let mut child = tokio::process::Command::new("powershell.exe");
            #[cfg(not(windows))]
            let mut child = tokio::process::Command::new("sh");
            #[cfg(windows)]
            child.args(["-NoProfile", "-NonInteractive", "-Command", &command]);
            #[cfg(not(windows))]
            child.args(["-lc", &command]);
            let result = child
                .env("MINIQ_SESSION_ID", &session_id)
                .env("MINIQ_TURN_STATUS", &status)
                .env("MINIQ_WORKSPACE", &workspace_path)
                .env("MINIQ_TITLE", &title)
                .output()
                .await;
            match result {
                Ok(output) if !output.status.success() => tracing::warn!(
                    session_id = %session_id,
                    status = %status,
                    code = ?output.status.code(),
                    "turn-ended hook exited unsuccessfully"
                ),
                Err(error) => {
                    tracing::warn!(session_id = %session_id, %error, "turn-ended hook failed")
                }
                _ => {
                    tracing::debug!(session_id = %session_id, status = %status, "turn-ended hook completed")
                }
            }
        });
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

    pub fn approval_mode_for_session(
        &self,
        session_id: &str,
    ) -> Result<ApprovalMode, miniq_memory::MemoryError> {
        Ok(self
            .store
            .session_approval_mode(session_id)?
            .unwrap_or_else(|| self.settings.lock().unwrap().approval_mode))
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
        let mut journal = self.event_journal.lock().unwrap();
        match &event {
            Event::AssistantDelta {
                session_id, delta, ..
            } => self.append_streaming_text(session_id, delta),
            Event::AssistantReplaced {
                session_id, text, ..
            } => self.replace_streaming_text(session_id, text),
            Event::MessageCreated {
                session_id,
                message,
            } if message.role == miniq_protocol::Role::Assistant => {
                self.clear_streaming_text(session_id)
            }
            Event::TurnCompleted { session_id, .. } | Event::TurnFailed { session_id, .. } => {
                self.clear_streaming_text(session_id)
            }
            _ => {}
        }
        let projected = journal.record(&event);
        let _ = self.events.send(event.clone());
        let _ = self
            .live_events
            .send(Arc::new(crate::event_journal::LiveEvent {
                original: event,
                projected,
            }));
    }

    /// Register a new turn for a session. Different sessions may run in
    /// parallel, including sessions that share a workspace.
    pub fn begin_turn(&self, session_id: &str) -> Option<CancellationToken> {
        let activity = self.activity.enter().ok()?;
        let mut turns = self.active_turns.lock().unwrap();
        if turns.contains_key(session_id) {
            return None;
        }
        let token = CancellationToken::new();
        turns.insert(
            session_id.to_string(),
            ActiveTurn {
                cancellation: token.clone(),
                _activity: activity,
            },
        );
        Some(token)
    }

    pub fn end_turn(&self, session_id: &str) {
        self.active_turns.lock().unwrap().remove(session_id);
    }

    pub fn has_active_turn(&self, session_id: &str) -> bool {
        self.active_turns.lock().unwrap().contains_key(session_id)
    }

    /// Wait until a turn that was already cancelled releases its slot.
    /// Returns false when the session's turn is still running uncancelled or
    /// does not stop within `timeout`.
    pub async fn wait_for_cancelled_turn(
        &self,
        session_id: &str,
        timeout: std::time::Duration,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let cancelled = match self.active_turns.lock().unwrap().get(session_id) {
                None => return true,
                Some(turn) => turn.cancellation.is_cancelled(),
            };
            if !cancelled || tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// Limit the next turn of `session_id` to `max_steps` model requests.
    pub fn set_turn_step_limit(&self, session_id: &str, max_steps: Option<usize>) {
        let mut limits = self.turn_step_limits.lock().unwrap();
        match max_steps {
            Some(max_steps) => {
                limits.insert(session_id.to_string(), max_steps);
            }
            None => {
                limits.remove(session_id);
            }
        }
    }

    pub fn take_turn_step_limit(&self, session_id: &str) -> Option<usize> {
        self.turn_step_limits.lock().unwrap().remove(session_id)
    }

    pub fn cancel_turn(&self, session_id: &str) -> bool {
        let turns = self.active_turns.lock().unwrap();
        match turns.get(session_id) {
            Some(turn) => {
                turn.cancellation.cancel();
                true
            }
            None => false,
        }
    }

    pub fn pause_turn(&self, session_id: &str) -> bool {
        let turns = self.active_turns.lock().unwrap();
        let Some(turn) = turns.get(session_id) else {
            return false;
        };
        self.paused_turns
            .lock()
            .unwrap()
            .insert(session_id.to_string());
        turn.cancellation.cancel();
        true
    }

    pub fn is_turn_paused(&self, session_id: &str) -> bool {
        self.paused_turns.lock().unwrap().contains(session_id)
    }

    pub fn resume_turn(&self, session_id: &str) -> bool {
        self.paused_turns.lock().unwrap().remove(session_id)
    }

    pub fn request_turn_resume(&self, session_id: &str) {
        self.pending_turn_resumes
            .lock()
            .unwrap()
            .insert(session_id.to_string());
    }

    pub fn take_turn_resume_request(&self, session_id: &str) -> bool {
        self.pending_turn_resumes.lock().unwrap().remove(session_id)
    }

    pub fn clear_paused_turn(&self, session_id: &str) -> bool {
        self.pending_turn_resumes.lock().unwrap().remove(session_id);
        self.paused_turns.lock().unwrap().remove(session_id)
    }

    pub fn cancel_all_turns(&self) -> usize {
        let turns = self.active_turns.lock().unwrap();
        for turn in turns.values() {
            turn.cancellation.cancel();
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

        state.replace_streaming_text("session", "前半段");
        state.append_streaming_text("session", "重试成功");
        assert_eq!(state.streaming_text("session"), "前半段重试成功");
        assert_eq!(state.streaming_text("other"), "");

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

    #[test]
    fn paused_turn_can_queue_resume_and_cancel_clears_both_states() {
        let state = AppState::new(
            Store::open_in_memory().unwrap(),
            "token".to_string(),
            Arc::new(MockProvider::new(Vec::new())),
        );
        let turn = state.begin_turn("session").unwrap();

        assert!(state.pause_turn("session"));
        assert!(turn.is_cancelled());
        assert!(state.is_turn_paused("session"));

        state.request_turn_resume("session");
        assert!(state.take_turn_resume_request("session"));
        state.request_turn_resume("session");
        assert!(state.clear_paused_turn("session"));
        assert!(!state.is_turn_paused("session"));
        assert!(!state.take_turn_resume_request("session"));
    }

    #[tokio::test]
    async fn malformed_browser_resolution_does_not_consume_pending_request() {
        let state = AppState::new(
            Store::open_in_memory().unwrap(),
            "token".to_string(),
            Arc::new(MockProvider::new(Vec::new())),
        );
        let receiver = state.register_browser_request("browser-1");
        assert!(
            !state.deliver_browser_result(miniq_protocol::BrowserDriverResolution {
                request_id: "browser-1".into(),
                result: None,
                error: None,
            })
        );
        let result = miniq_protocol::BrowserDriverResult {
            capabilities: miniq_protocol::BrowserCapabilities::default(),
            result: serde_json::json!({"url":"https://example.com/"}),
        };
        assert!(
            state.deliver_browser_result(miniq_protocol::BrowserDriverResolution {
                request_id: "browser-1".into(),
                result: Some(result),
                error: None,
            })
        );
        assert!(receiver.await.unwrap().is_ok());
        assert!(
            !state.deliver_browser_result(miniq_protocol::BrowserDriverResolution {
                request_id: "browser-1".into(),
                result: None,
                error: Some("late error".into()),
            })
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn turn_ended_hook_receives_safe_environment_and_empty_is_disabled() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("hook.txt");
        let workspace_path = directory.path().join("workspace");
        std::fs::create_dir_all(&workspace_path).unwrap();
        let state = AppState::new(
            Store::open_in_memory().unwrap(),
            "token".to_string(),
            Arc::new(MockProvider::new(Vec::new())),
        );
        let workspace = state
            .store
            .create_workspace(workspace_path.to_str().unwrap(), "hook project")
            .unwrap();
        let session = state
            .store
            .create_session(&workspace.id, "hook session")
            .unwrap();
        let mut settings = state.settings.lock().unwrap().clone();
        settings.turn_ended_command = Some(format!("printf '%s|%s|%s|%s' \"$MINIQ_SESSION_ID\" \"$MINIQ_TURN_STATUS\" \"$MINIQ_WORKSPACE\" \"$MINIQ_TITLE\" > '{}'", output.display()));
        *state.settings.lock().unwrap() = settings;
        state.run_turn_ended_hook(&session.id, "failed");
        let expected_prefix = format!("{}|failed|", session.id);
        for _ in 0..50 {
            if std::fs::read_to_string(&output)
                .map(|value| value.starts_with(&expected_prefix))
                .unwrap_or(false)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let value = std::fs::read_to_string(output).unwrap();
        assert!(value.starts_with(&format!("{}|failed|", session.id)));
        assert!(value.ends_with("|hook session"));

        let mut settings = state.settings.lock().unwrap().clone();
        settings.turn_ended_command = None;
        *state.settings.lock().unwrap() = settings;
        state.run_turn_ended_hook(&session.id, "succeeded");
    }
}

/// Keep one previous copy of `settings.json` before overwriting it.
fn backup_before_save(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let target = settings_last_backup(path);
    std::fs::read(path)
        .and_then(|raw| miniq_local::write_private_bytes(&target, &raw))
        .map_err(|error| format!("failed to back up settings before saving: {error}"))
}
