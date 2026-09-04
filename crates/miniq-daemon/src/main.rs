use miniq_daemon::state::AppState;
use miniq_daemon::{data_dir, generate_token, server, write_connection_info, ConnectionInfo};
use miniq_memory::Store;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;

    // Logs go to stdout (visible in dev terminals) and to a daily-rotated
    // file so installed builds, which run without a console, stay debuggable.
    let file_appender = tracing_appender::rolling::daily(dir.join("logs"), "daemon.log");
    let (file_writer, _log_guard) = tracing_appender::non_blocking(file_appender);
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(file_writer),
        )
        .init();
    let store = Store::open(&dir.join("miniq.db"))?;
    let recovered = store.recover_interrupted_work()?;
    if recovered != miniq_memory::StartupRecovery::default() {
        tracing::warn!(
            sessions = recovered.sessions_failed,
            tool_calls = recovered.tool_calls_cancelled,
            approvals = recovered.approvals_rejected,
            "recovered interrupted work from the previous daemon process"
        );
    }

    let token = std::env::var("MINIQ_TOKEN").unwrap_or_else(|_| generate_token());
    let port: u16 = std::env::var("MINIQ_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);

    let listener = server::bind(port).await?;
    let addr = listener.local_addr()?;
    write_connection_info(
        &dir,
        &ConnectionInfo {
            port: addr.port(),
            token: token.clone(),
            pid: std::process::id(),
        },
    )?;
    tracing::info!("miniq-daemon listening on ws://{addr}/ws");

    let settings_path = dir.join("settings.json");
    let settings = miniq_daemon::load_settings(&settings_path);
    let state = AppState::with_settings(store, token, settings, settings_path);
    if let Err(error) = state.plugins.scan_and_load().await {
        tracing::error!(%error, "failed to scan plugin directory");
    }
    miniq_daemon::schedule::spawn_scheduler(state.clone());
    miniq_daemon::remote::spawn(state.clone());
    let result = server::serve(listener, state).await;
    let _ = std::fs::remove_file(dir.join("daemon.json"));
    result
}
