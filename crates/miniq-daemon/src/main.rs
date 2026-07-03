use miniq_daemon::state::AppState;
use miniq_daemon::{data_dir, generate_token, server, write_connection_info, ConnectionInfo};
use miniq_memory::Store;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    let store = Store::open(&dir.join("miniq.db"))?;

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
    server::serve(listener, state).await
}
