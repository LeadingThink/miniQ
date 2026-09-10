//! Isolated browser acceptance using the real RPC gateway and disposable state.
use miniq_daemon::{server, state::AppState};
use miniq_memory::Store;
use miniq_protocol::Role;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let directory = std::env::args()
        .nth(1)
        .expect("pass a preview fixture directory");
    let store = Store::open_in_memory()?;
    let workspace = store.create_workspace(&directory, "移动端文件验收")?;
    let session = store.create_session(&workspace.id, "远程产物预览（隔离测试）")?;
    store.append_message(&session.id, Role::Assistant,
        "请逐个查看产物，再针对文件继续提问。\n\n[报告](report.md) · [PDF](document.pdf) · [Word](document.docx) · [幻灯片](slides.pptx) · [表格](data.csv) · [图片](assets/logo.png) · [网页](preview.html) · [视频](clip.mp4)")?;
    for path in [
        "report.md",
        "document.pdf",
        "document.docx",
        "slides.pptx",
        "data.csv",
        "preview.html",
        "clip.mp4",
    ] {
        store.create_artifact(&session.id, path, "file", path)?;
    }
    let state = AppState::new(
        store,
        "isolated-preview".into(),
        Arc::new(miniq_models::mock::MockProvider::new(vec![])),
    );
    let listener = server::bind(0).await?;
    println!("isolated preview port: {}", listener.local_addr()?.port());
    server::serve(listener, state).await?;
    Ok(())
}
