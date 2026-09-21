use miniq_daemon::{gateway, state::AppState};
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_protocol::RpcRequest;
use serde_json::{json, Value};
use std::sync::Arc;

async fn call(state: &AppState, method: &str, params: Value) -> Value {
    let request: RpcRequest = serde_json::from_value(
        json!({"jsonrpc":"2.0","id":"test","method":method,"params":params}),
    )
    .unwrap();
    serde_json::to_value(gateway::dispatch(state, request).await).unwrap()
}

#[tokio::test]
async fn memory_rpc_is_paged_scope_bound_and_checks_delete_version() {
    let store = Store::open_in_memory().unwrap();
    let a = store.create_workspace("/a", "A").unwrap();
    let b = store.create_workspace("/b", "B").unwrap();
    let item = store
        .create_memory(Some(&a.id), "workspace", "private A")
        .unwrap();
    store
        .create_memory(Some(&b.id), "workspace", "private B")
        .unwrap();
    store
        .create_memory(None, "global", "global preference")
        .unwrap();
    let state = AppState::new(
        store,
        "memory-test".into(),
        Arc::new(MockProvider::text("unused")),
    );
    let target = json!({"scope":"workspace","workspaceId":a.id});
    let page = call(&state, "memory.list", json!({"target":target,"limit":1})).await;
    assert_eq!(page["result"]["memories"].as_array().unwrap().len(), 1);
    assert_eq!(page["result"]["memories"][0]["content"], "private A");
    assert!(page["result"]["nextCursor"].is_null());
    for invalid in [
        json!({"target":{"scope":"global","workspaceId":a.id}}),
        json!({"target":{"scope":"workspace"}}),
        json!({"target":{"scope":"global"},"limit":101}),
    ] {
        assert_eq!(
            call(&state, "memory.list", invalid).await["error"]["code"],
            -32602
        );
    }
    let incorrect = call(&state, "memory.delete", json!({"target":{"scope":"workspace","workspaceId":b.id},"id":item.id,"expectedUpdatedAt":item.updated_at,"expectedContent":item.content})).await;
    assert_eq!(incorrect["error"]["code"], -32602);
    let stale = call(
        &state,
        "memory.delete",
        json!({"target":target,"id":item.id,"expectedUpdatedAt":"stale","expectedContent":item.content}),
    )
    .await;
    assert_eq!(stale["error"]["code"], -32602);
    let changed = call(&state, "memory.delete", json!({"target":target,"id":item.id,"expectedUpdatedAt":item.updated_at,"expectedContent":"different text"})).await;
    assert_eq!(changed["error"]["code"], -32602);
    let deleted = call(
        &state,
        "memory.delete",
        json!({"target":target,"id":item.id,"expectedUpdatedAt":item.updated_at,"expectedContent":item.content}),
    )
    .await;
    assert_eq!(deleted["result"]["deleted"], item.id);
    assert_eq!(
        call(&state, "memory.list", json!({"target":target})).await["result"]["memories"],
        json!([])
    );
    assert_eq!(
        call(&state, "memory.list", json!({"target":{"scope":"global"}})).await["result"]
            ["memories"][0]["content"],
        "global preference"
    );
}
