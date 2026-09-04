use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use miniq_protocol::{PluginInfo, PluginProcessState, PluginRuntime, PluginStatus};
use miniq_tools::{RegistrationHandle, ToolRouter};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::error::{PluginError, PluginFailureKind, PluginLimits};
use crate::host::{WasmPlugin, WasmTool};
use crate::manifest::PluginManifest;
use crate::node::{NodePluginProcess, NodeTool};

const TRUST_STORE_FILE: &str = ".trusted-node.json";
const NODE_HOST_DIRECTORY: &str = ".miniq-node-plugin-host-v1";
static TRUST_TEMP_ID: AtomicU64 = AtomicU64::new(0);
static INSTALL_TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Default, Deserialize, Serialize)]
struct TrustStore(BTreeMap<String, String>);

struct PluginRecord {
    info: PluginInfo,
    manifest_path: PathBuf,
    handles: Arc<std::sync::Mutex<Vec<RegistrationHandle>>>,
    cancellation: CancellationToken,
    node: Option<Arc<NodePluginProcess>>,
}

impl PluginRecord {
    fn current_info(&self) -> PluginInfo {
        let mut info = self.info.clone();
        if let Some(error) = self.node.as_ref().and_then(|node| node.failure()) {
            info.status = PluginStatus::Failed;
            info.process_state = PluginProcessState::Failed;
            info.error = Some(error);
            info.tools.clear();
        }
        info
    }

    fn discovered(manifest: &PluginManifest, manifest_path: PathBuf) -> Self {
        Self {
            info: PluginInfo {
                id: manifest.id.clone(),
                name: manifest.name.clone(),
                version: manifest.version.to_string(),
                enabled: manifest.enabled,
                status: PluginStatus::Discovered,
                tools: Vec::new(),
                error: None,
                description: manifest.description.clone(),
                author: manifest.author.clone(),
                runtime: manifest.runtime,
                capabilities: manifest
                    .capabilities
                    .iter()
                    .map(|value| format!("{value:?}").to_lowercase())
                    .collect(),
                permissions: manifest
                    .permissions
                    .iter()
                    .map(|value| format!("{value:?}").to_lowercase())
                    .collect(),
                trusted_code: manifest.runtime == PluginRuntime::Node,
                process_state: if manifest.runtime == PluginRuntime::Node {
                    PluginProcessState::Stopped
                } else {
                    PluginProcessState::NotApplicable
                },
                entry: manifest.entry.to_string_lossy().into_owned(),
                engine_node: manifest
                    .engine
                    .as_ref()
                    .map(|engine| engine.node.to_string()),
                trust_confirmed: manifest.runtime == PluginRuntime::Wasm,
            },
            manifest_path,
            handles: Arc::new(std::sync::Mutex::new(Vec::new())),
            cancellation: CancellationToken::new(),
            node: None,
        }
    }

    fn failed(id: String, name: String, manifest_path: PathBuf, error: PluginError) -> Self {
        Self {
            info: PluginInfo {
                id,
                name,
                version: String::new(),
                enabled: false,
                status: PluginStatus::Failed,
                tools: Vec::new(),
                error: Some(error.to_string()),
                description: None,
                author: None,
                runtime: PluginRuntime::Wasm,
                capabilities: Vec::new(),
                permissions: Vec::new(),
                trusted_code: false,
                process_state: PluginProcessState::NotApplicable,
                entry: String::new(),
                engine_node: None,
                trust_confirmed: false,
            },
            manifest_path,
            handles: Arc::new(std::sync::Mutex::new(Vec::new())),
            cancellation: CancellationToken::new(),
            node: None,
        }
    }
}

pub struct PluginManager {
    root: PathBuf,
    router: Arc<ToolRouter>,
    limits: PluginLimits,
    records: RwLock<BTreeMap<String, PluginRecord>>,
}

impl PluginManager {
    pub fn new(root: PathBuf, router: Arc<ToolRouter>, limits: PluginLimits) -> Self {
        Self {
            root,
            router,
            limits,
            records: RwLock::new(BTreeMap::new()),
        }
    }

    pub fn list(&self) -> Vec<PluginInfo> {
        self.records
            .read()
            .unwrap()
            .values()
            .map(PluginRecord::current_info)
            .collect()
    }

    pub fn diagnostics(&self, id: &str) -> Option<PluginInfo> {
        self.records
            .read()
            .unwrap()
            .get(id)
            .map(PluginRecord::current_info)
    }

    pub async fn install_from_directory(&self, source: &Path) -> Result<PluginInfo, PluginError> {
        let manifest_path = source.join("manifest.toml");
        let raw = std::fs::read_to_string(&manifest_path).map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidManifest, error.to_string())
        })?;
        let manifest = PluginManifest::parse(&raw).map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidManifest, error.to_string())
        })?;
        manifest.validate().map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidManifest, error.to_string())
        })?;
        secure_entry(source, &manifest.entry)?;

        std::fs::create_dir_all(&self.root).map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidEntry, error.to_string())
        })?;
        let destination = self.root.join(&manifest.id);
        if destination.exists() || self.records.read().unwrap().contains_key(&manifest.id) {
            return Err(PluginError::new(
                PluginFailureKind::InvalidManifest,
                "plugin is already installed",
            ));
        }
        let temp = self.root.join(format!(
            ".install-{}-{}",
            manifest.id,
            INSTALL_TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        if let Err(error) = copy_directory(source, &temp) {
            let _ = std::fs::remove_dir_all(&temp);
            return Err(error);
        }
        if let Err(error) = std::fs::rename(&temp, &destination) {
            let _ = std::fs::remove_dir_all(&temp);
            return Err(PluginError::new(
                PluginFailureKind::InvalidEntry,
                error.to_string(),
            ));
        }

        self.load_directory(&destination).await;
        self.diagnostics(&manifest.id).ok_or_else(|| {
            PluginError::new(
                PluginFailureKind::InvalidManifest,
                "plugin not found after install",
            )
        })
    }

    pub async fn uninstall(&self, id: &str) -> Result<(), PluginError> {
        let directory = self
            .records
            .read()
            .unwrap()
            .get(id)
            .and_then(|record| record.manifest_path.parent().map(Path::to_path_buf))
            .ok_or_else(|| {
                PluginError::new(PluginFailureKind::InvalidManifest, "plugin not found")
            })?;
        self.unload(id).await;
        if let Err(error) = std::fs::remove_dir_all(&directory) {
            self.load_directory(&directory).await;
            return Err(PluginError::new(
                PluginFailureKind::InvalidEntry,
                error.to_string(),
            ));
        }
        self.set_trust(id, None)
    }

    pub async fn scan_and_load(&self) -> Result<Vec<PluginInfo>, PluginError> {
        std::fs::create_dir_all(&self.root).map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidEntry, error.to_string())
        })?;
        let mut directories = std::fs::read_dir(&self.root)
            .map_err(|error| PluginError::new(PluginFailureKind::InvalidEntry, error.to_string()))?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter(|entry| entry.file_name() != NODE_HOST_DIRECTORY)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        directories.sort();
        let old_ids = self
            .records
            .read()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in old_ids {
            self.unload(&id).await;
        }
        for directory in directories {
            self.load_directory(&directory).await;
        }
        Ok(self.list())
    }

    pub async fn reload(&self, id: &str) -> Result<PluginInfo, PluginError> {
        let manifest_path = self
            .records
            .read()
            .unwrap()
            .get(id)
            .map(|record| record.manifest_path.clone())
            .ok_or_else(|| {
                PluginError::new(PluginFailureKind::InvalidManifest, "plugin not found")
            })?;
        self.unload(id).await;
        self.load_directory(manifest_path.parent().unwrap()).await;
        self.diagnostics(id).ok_or_else(|| {
            PluginError::new(
                PluginFailureKind::InvalidManifest,
                "plugin not found after reload",
            )
        })
    }

    pub async fn set_enabled(
        &self,
        id: &str,
        enabled: bool,
        confirm_trusted_code: bool,
    ) -> Result<PluginInfo, PluginError> {
        let manifest_path = self
            .records
            .read()
            .unwrap()
            .get(id)
            .map(|record| record.manifest_path.clone())
            .ok_or_else(|| {
                PluginError::new(PluginFailureKind::InvalidManifest, "plugin not found")
            })?;
        let raw = std::fs::read_to_string(&manifest_path).map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidManifest, error.to_string())
        })?;
        let mut manifest = PluginManifest::parse(&raw).map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidManifest, error.to_string())
        })?;
        if enabled && manifest.runtime == PluginRuntime::Node && !confirm_trusted_code {
            return Err(PluginError::new(
                PluginFailureKind::Incompatible,
                "enabling a Node plugin requires explicit trusted-code confirmation",
            ));
        }
        let trust_update = if manifest.runtime == PluginRuntime::Node && enabled {
            let directory = manifest_path.parent().ok_or_else(|| {
                PluginError::new(
                    PluginFailureKind::InvalidEntry,
                    "plugin directory is missing",
                )
            })?;
            let entry = secure_entry(directory, &manifest.entry)?;
            Some(trust_fingerprint(&manifest, &entry)?)
        } else {
            None
        };
        manifest.enabled = enabled;
        let serialized = toml::to_string_pretty(&manifest).map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidManifest, error.to_string())
        })?;
        if manifest.runtime == PluginRuntime::Node {
            if enabled {
                self.set_trust(&manifest.id, trust_update)?;
            } else {
                self.set_trust(&manifest.id, None)?;
            }
        }
        std::fs::write(&manifest_path, serialized).map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidManifest, error.to_string())
        })?;
        self.unload(id).await;
        self.load_directory(manifest_path.parent().unwrap()).await;
        self.diagnostics(id).ok_or_else(|| {
            PluginError::new(
                PluginFailureKind::InvalidManifest,
                "plugin disappeared after update",
            )
        })
    }

    pub async fn unload(&self, id: &str) {
        let record = { self.records.write().unwrap().remove(id) };
        if let Some(mut record) = record {
            record.info.status = PluginStatus::Unloading;
            record.cancellation.cancel();
            record.handles.lock().unwrap().clear();
            if let Some(node) = record.node {
                node.shutdown().await;
            }
        }
    }

    async fn load_directory(&self, directory: &Path) {
        let manifest_path = directory.join("manifest.toml");
        let raw = match std::fs::read_to_string(&manifest_path) {
            Ok(raw) => raw,
            Err(error) => {
                let id = directory
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("invalid-plugin")
                    .to_string();
                self.insert_failure(
                    id.clone(),
                    id,
                    manifest_path,
                    PluginError::new(PluginFailureKind::InvalidManifest, error.to_string()),
                );
                return;
            }
        };
        let manifest = match PluginManifest::parse(&raw) {
            Ok(manifest) => manifest,
            Err(error) => {
                let id = directory
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("invalid-plugin")
                    .to_string();
                self.insert_failure(
                    id.clone(),
                    id,
                    manifest_path,
                    PluginError::new(PluginFailureKind::InvalidManifest, error.to_string()),
                );
                return;
            }
        };
        let directory_id = directory.file_name().and_then(|name| name.to_str());
        if directory_id != Some(manifest.id.as_str()) {
            let id = directory_id.unwrap_or("invalid-plugin").to_string();
            self.insert_failure(
                id.clone(),
                manifest.name,
                manifest_path,
                PluginError::new(
                    PluginFailureKind::IdentityMismatch,
                    "plugin directory name must match manifest id",
                ),
            );
            return;
        }
        let mut record = PluginRecord::discovered(&manifest, manifest_path.clone());
        if manifest.runtime == PluginRuntime::Node {
            let confirmed = secure_entry(directory, &manifest.entry)
                .and_then(|entry| trust_fingerprint(&manifest, &entry))
                .ok()
                .is_some_and(|fingerprint| self.is_trusted(&manifest.id, &fingerprint));
            record.info.trust_confirmed = confirmed;
            record.info.enabled = manifest.enabled && confirmed;
            if !confirmed {
                record.info.status = PluginStatus::Disabled;
                self.records
                    .write()
                    .unwrap()
                    .insert(manifest.id.clone(), record);
                return;
            }
        }
        if !manifest.enabled {
            record.info.status = PluginStatus::Disabled;
            self.records
                .write()
                .unwrap()
                .insert(manifest.id.clone(), record);
            return;
        }
        record.info.status = PluginStatus::Loading;
        if manifest.runtime == PluginRuntime::Node {
            record.info.process_state = PluginProcessState::Starting;
        }
        self.records
            .write()
            .unwrap()
            .insert(manifest.id.clone(), record);
        if let Err(error) = self.activate(directory, manifest, manifest_path).await {
            if let Some(record) = self.records.write().unwrap().get_mut(&error.0) {
                record.info.status = PluginStatus::Failed;
                record.info.error = Some(error.1.to_string());
                record.info.process_state = if record.info.runtime == PluginRuntime::Node {
                    PluginProcessState::Failed
                } else {
                    PluginProcessState::NotApplicable
                };
                record.cancellation.cancel();
                record.handles.lock().unwrap().clear();
            }
        }
    }

    async fn activate(
        &self,
        directory: &Path,
        manifest: PluginManifest,
        _manifest_path: PathBuf,
    ) -> Result<(), (String, PluginError)> {
        let id = manifest.id.clone();
        let entry =
            secure_entry(directory, &manifest.entry).map_err(|error| (id.clone(), error))?;
        let cancellation = CancellationToken::new();
        let handles = self
            .records
            .read()
            .unwrap()
            .get(&id)
            .map(|record| record.handles.clone())
            .ok_or_else(|| {
                (
                    id.clone(),
                    PluginError::new(PluginFailureKind::Cancelled, "plugin was unloaded"),
                )
            })?;
        let (tools, node): (
            Vec<Arc<dyn miniq_tools::Tool>>,
            Option<Arc<NodePluginProcess>>,
        ) = match manifest.runtime {
            PluginRuntime::Wasm => {
                let wasm = std::fs::read(&entry).map_err(|error| {
                    (
                        id.clone(),
                        PluginError::new(PluginFailureKind::InvalidEntry, error.to_string()),
                    )
                })?;
                let (plugin, metadata) =
                    WasmPlugin::load(manifest.clone(), &wasm, self.limits.clone())
                        .await
                        .map_err(|error| (id.clone(), error))?;
                (
                    metadata
                        .into_iter()
                        .map(|tool| {
                            Arc::new(WasmTool::new(plugin.clone(), tool, cancellation.clone()))
                                as Arc<dyn miniq_tools::Tool>
                        })
                        .collect(),
                    None,
                )
            }
            PluginRuntime::Node => {
                let (plugin, metadata) = NodePluginProcess::start(
                    manifest.clone(),
                    directory,
                    &entry,
                    self.limits.clone(),
                    handles.clone(),
                )
                .await
                .map_err(|error| (id.clone(), error))?;
                let tools = metadata
                    .into_iter()
                    .map(|tool| {
                        Arc::new(NodeTool::new(plugin.clone(), tool, cancellation.clone()))
                            as Arc<dyn miniq_tools::Tool>
                    })
                    .collect();
                (tools, Some(plugin))
            }
        };
        let mut tool_names = Vec::with_capacity(tools.len());
        for tool in tools {
            if let Some(error) = node.as_ref().and_then(|process| process.failure()) {
                handles.lock().unwrap().clear();
                cancellation.cancel();
                return Err((id, PluginError::new(PluginFailureKind::Process, error)));
            }
            tool_names.push(tool.name().to_string());
            match self.router.register_plugin(
                tool,
                id.clone(),
                match manifest.runtime {
                    PluginRuntime::Wasm => "wasm",
                    PluginRuntime::Node => "node",
                }
                .to_string(),
                manifest.version.to_string(),
            ) {
                Ok(handle) => handles.lock().unwrap().push(handle),
                Err(error) => {
                    handles.lock().unwrap().clear();
                    cancellation.cancel();
                    return Err((
                        id,
                        PluginError::new(
                            PluginFailureKind::RegistrationConflict,
                            error.to_string(),
                        ),
                    ));
                }
            }
            if let Some(error) = node.as_ref().and_then(|process| process.failure()) {
                handles.lock().unwrap().clear();
                cancellation.cancel();
                return Err((id, PluginError::new(PluginFailureKind::Process, error)));
            }
        }
        if let Some(error) = node.as_ref().and_then(|process| process.failure()) {
            handles.lock().unwrap().clear();
            cancellation.cancel();
            return Err((id, PluginError::new(PluginFailureKind::Process, error)));
        }
        if let Some(record) = self.records.write().unwrap().get_mut(&id) {
            record.info.status = PluginStatus::Active;
            record.info.tools = tool_names;
            record.info.error = None;
            record.info.process_state = if manifest.runtime == PluginRuntime::Node {
                PluginProcessState::Running
            } else {
                PluginProcessState::NotApplicable
            };
            record.cancellation = cancellation;
            record.node = node;
        }
        Ok(())
    }

    fn insert_failure(&self, id: String, name: String, path: PathBuf, error: PluginError) {
        self.records
            .write()
            .unwrap()
            .insert(id.clone(), PluginRecord::failed(id, name, path, error));
    }

    fn is_trusted(&self, id: &str, fingerprint: &str) -> bool {
        self.read_trust_store()
            .0
            .get(id)
            .is_some_and(|stored| stored == fingerprint)
    }

    fn set_trust(&self, id: &str, fingerprint: Option<String>) -> Result<(), PluginError> {
        let mut store = self.read_trust_store();
        match fingerprint {
            Some(fingerprint) => {
                store.0.insert(id.to_string(), fingerprint);
            }
            None => {
                store.0.remove(id);
            }
        }
        let bytes = serde_json::to_vec_pretty(&store)
            .map_err(|error| PluginError::new(PluginFailureKind::Process, error.to_string()))?;
        atomic_write(&self.root.join(TRUST_STORE_FILE), &bytes)
            .map_err(|error| PluginError::new(PluginFailureKind::Process, error.to_string()))
    }

    fn read_trust_store(&self) -> TrustStore {
        std::fs::read(self.root.join(TRUST_STORE_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), PluginError> {
    std::fs::create_dir(destination)
        .map_err(|error| PluginError::new(PluginFailureKind::InvalidEntry, error.to_string()))?;
    let entries = std::fs::read_dir(source)
        .map_err(|error| PluginError::new(PluginFailureKind::InvalidEntry, error.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidEntry, error.to_string())
        })?;
        let file_type = entry.file_type().map_err(|error| {
            PluginError::new(PluginFailureKind::InvalidEntry, error.to_string())
        })?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), target).map_err(|error| {
                PluginError::new(PluginFailureKind::InvalidEntry, error.to_string())
            })?;
        } else {
            return Err(PluginError::new(
                PluginFailureKind::InvalidEntry,
                "plugin directories cannot contain symbolic links",
            ));
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp_id = TRUST_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("tmp-{}-{temp_id}", std::process::id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn trust_fingerprint(manifest: &PluginManifest, entry: &Path) -> Result<String, PluginError> {
    let entry_bytes = std::fs::read(entry)
        .map_err(|error| PluginError::new(PluginFailureKind::InvalidEntry, error.to_string()))?;
    let trust_fields = serde_json::to_vec(&(
        &manifest.id,
        &manifest.version,
        manifest.runtime,
        &manifest.entry,
        &manifest.permissions,
        &manifest.engine,
    ))
    .map_err(|error| PluginError::new(PluginFailureKind::InvalidManifest, error.to_string()))?;
    let mut digest = Sha256::new();
    digest.update(trust_fields);
    digest.update([0]);
    digest.update(entry_bytes);
    Ok(format!("{:x}", digest.finalize()))
}

fn secure_entry(directory: &Path, entry: &Path) -> Result<PathBuf, PluginError> {
    let root = directory
        .canonicalize()
        .map_err(|error| PluginError::new(PluginFailureKind::InvalidEntry, error.to_string()))?;
    let candidate = directory
        .join(entry)
        .canonicalize()
        .map_err(|error| PluginError::new(PluginFailureKind::InvalidEntry, error.to_string()))?;
    if !candidate.starts_with(&root) || !candidate.is_file() {
        return Err(PluginError::new(
            PluginFailureKind::InvalidEntry,
            "plugin entry escapes its plugin directory",
        ));
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disabled_manifest(id: &str) -> String {
        format!(
            r#"id = "{id}"
name = "Test Plugin"
version = "1.0.0"
api_version = "1.0.0"
runtime = "wasm"
entry = "plugin.wasm"
capabilities = ["tool"]
enabled = false
"#
        )
    }

    fn node_manifest(id: &str, version: &str, permissions: &str) -> String {
        format!(
            r#"id = "{id}"
name = "Test Node Plugin"
version = "{version}"
api_version = "1.0.0"
runtime = "node"
entry = "index.mjs"
capabilities = ["tool"]
permissions = [{permissions}]
enabled = true

[engine]
node = ">=22"
"#
        )
    }

    #[tokio::test]
    async fn discovers_disabled_plugin_without_loading_wasm() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("dev.miniq.test");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(
            directory.join("manifest.toml"),
            disabled_manifest("dev.miniq.test"),
        )
        .unwrap();
        let manager = PluginManager::new(
            temp.path().to_path_buf(),
            Arc::new(ToolRouter::new()),
            PluginLimits::default(),
        );

        let plugins = manager.scan_and_load().await.unwrap();

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].status, PluginStatus::Disabled);
    }

    #[tokio::test]
    async fn ignores_internal_node_host_directory() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join(NODE_HOST_DIRECTORY)).unwrap();
        let manager = PluginManager::new(
            temp.path().to_path_buf(),
            Arc::new(ToolRouter::new()),
            PluginLimits::default(),
        );

        assert!(manager.scan_and_load().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_manifest_id_that_differs_from_directory() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("dev.miniq.directory");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(
            directory.join("manifest.toml"),
            disabled_manifest("dev.miniq.manifest"),
        )
        .unwrap();
        let manager = PluginManager::new(
            temp.path().to_path_buf(),
            Arc::new(ToolRouter::new()),
            PluginLimits::default(),
        );

        let plugins = manager.scan_and_load().await.unwrap();

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].status, PluginStatus::Failed);
        assert!(plugins[0]
            .error
            .as_deref()
            .unwrap()
            .contains("directory name"));
    }

    #[tokio::test]
    async fn rescan_removes_deleted_plugin_records() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("dev.miniq.test");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(
            directory.join("manifest.toml"),
            disabled_manifest("dev.miniq.test"),
        )
        .unwrap();
        let manager = PluginManager::new(
            temp.path().to_path_buf(),
            Arc::new(ToolRouter::new()),
            PluginLimits::default(),
        );
        manager.scan_and_load().await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();

        assert!(manager.scan_and_load().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn installs_and_uninstalls_plugin_directory() {
        let installed = tempfile::tempdir().unwrap();
        let source_root = tempfile::tempdir().unwrap();
        let source = source_root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(
            source.join("manifest.toml"),
            disabled_manifest("dev.miniq.test"),
        )
        .unwrap();
        std::fs::write(source.join("plugin.wasm"), b"wasm").unwrap();
        let manager = PluginManager::new(
            installed.path().to_path_buf(),
            Arc::new(ToolRouter::new()),
            PluginLimits::default(),
        );

        let plugin = manager.install_from_directory(&source).await.unwrap();

        assert_eq!(plugin.id, "dev.miniq.test");
        assert!(installed
            .path()
            .join("dev.miniq.test/manifest.toml")
            .is_file());
        assert!(manager.install_from_directory(&source).await.is_err());

        manager.uninstall("dev.miniq.test").await.unwrap();
        assert!(manager.list().is_empty());
        assert!(!installed.path().join("dev.miniq.test").exists());
    }

    #[tokio::test]
    async fn node_manifest_cannot_self_authorize_trusted_code() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("dev.miniq.node-test");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(
            directory.join("manifest.toml"),
            node_manifest("dev.miniq.node-test", "1.0.0", "\"workspace_read\""),
        )
        .unwrap();
        std::fs::write(directory.join("index.mjs"), "export default {};").unwrap();
        let manager = PluginManager::new(
            temp.path().to_path_buf(),
            Arc::new(ToolRouter::new()),
            PluginLimits::default(),
        );

        let plugins = manager.scan_and_load().await.unwrap();

        assert_eq!(plugins[0].status, PluginStatus::Disabled);
        assert!(!plugins[0].enabled);
        assert!(!plugins[0].trust_confirmed);
        assert_eq!(plugins[0].process_state, PluginProcessState::Stopped);
    }

    #[test]
    fn node_trust_changes_with_security_relevant_inputs() {
        let temp = tempfile::tempdir().unwrap();
        let entry = temp.path().join("index.mjs");
        std::fs::write(&entry, "export default {};").unwrap();
        let base = PluginManifest::parse(&node_manifest(
            "dev.miniq.node-test",
            "1.0.0",
            "\"workspace_read\"",
        ))
        .unwrap();
        let fingerprint = trust_fingerprint(&base, &entry).unwrap();

        let version_changed = PluginManifest::parse(&node_manifest(
            "dev.miniq.node-test",
            "1.0.1",
            "\"workspace_read\"",
        ))
        .unwrap();
        assert_ne!(
            fingerprint,
            trust_fingerprint(&version_changed, &entry).unwrap()
        );

        let permissions_changed = PluginManifest::parse(&node_manifest(
            "dev.miniq.node-test",
            "1.0.0",
            "\"workspace_write\"",
        ))
        .unwrap();
        assert_ne!(
            fingerprint,
            trust_fingerprint(&permissions_changed, &entry).unwrap()
        );

        std::fs::write(&entry, "export default { changed: true };").unwrap();
        assert_ne!(fingerprint, trust_fingerprint(&base, &entry).unwrap());
    }

    #[test]
    fn trust_store_updates_and_removes_entries() {
        let temp = tempfile::tempdir().unwrap();
        let manager = PluginManager::new(
            temp.path().to_path_buf(),
            Arc::new(ToolRouter::new()),
            PluginLimits::default(),
        );

        manager
            .set_trust("dev.miniq.node-test", Some("first".into()))
            .unwrap();
        assert!(manager.is_trusted("dev.miniq.node-test", "first"));
        manager
            .set_trust("dev.miniq.node-test", Some("second".into()))
            .unwrap();
        assert!(!manager.is_trusted("dev.miniq.node-test", "first"));
        assert!(manager.is_trusted("dev.miniq.node-test", "second"));
        manager.set_trust("dev.miniq.node-test", None).unwrap();
        assert!(!manager.is_trusted("dev.miniq.node-test", "second"));

        let files = std::fs::read_dir(temp.path()).unwrap().count();
        assert_eq!(files, 1);
    }

    #[test]
    fn rejects_entry_outside_plugin_directory() {
        let temp = tempfile::tempdir().unwrap();
        let plugin = temp.path().join("plugin");
        std::fs::create_dir(&plugin).unwrap();
        std::fs::write(temp.path().join("outside.wasm"), b"wasm").unwrap();
        assert!(secure_entry(&plugin, Path::new("../outside.wasm")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let plugin = temp.path().join("plugin");
        std::fs::create_dir(&plugin).unwrap();
        let outside = temp.path().join("outside.wasm");
        std::fs::write(&outside, b"wasm").unwrap();
        symlink(&outside, plugin.join("plugin.wasm")).unwrap();
        assert!(secure_entry(&plugin, Path::new("plugin.wasm")).is_err());
    }
}
