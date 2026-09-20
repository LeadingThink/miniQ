use super::*;

fn detail(host: Option<&str>) -> Value {
    let event = json!({"type":"assistant_delta","sessionId":"same","delta":"text"});
    match host {
        Some(host) => json!({"type":"host_event","hostId":host,"event":event}),
        None => event,
    }
}

#[test]
fn same_session_id_on_different_hosts_never_shares_detail_events() {
    let mut subscriptions = Subscriptions::default();
    subscriptions.observe(
        "phone",
        &json!({"type":"remote_select","hostId":"alpha","sessionId":"same"}),
    );
    subscriptions.observe(
        "tablet",
        &json!({"type":"remote_select","sessionId":"same"}),
    );
    subscriptions.event(detail(Some("alpha")));
    subscriptions.event(detail(Some("beta")));
    subscriptions.event(detail(None));
    assert_eq!(
        subscriptions.0["phone"].pending,
        vec![detail(Some("alpha"))]
    );
    assert_eq!(subscriptions.0["tablet"].pending, vec![detail(None)]);
}

#[test]
fn navigation_discards_old_pending_details_but_preserves_all_host_summaries() {
    let mut subscriptions = Subscriptions::default();
    subscriptions.observe(
        "phone",
        &json!({"type":"remote_select","hostId":"alpha","sessionId":"same"}),
    );
    let summary = json!({"type":"host_event","hostId":"alpha","event":{"type":"session_status_changed","sessionId":"same","status":"running"}});
    let changed = json!({"type":"host_changed","hostId":"beta"});
    subscriptions.event(detail(Some("alpha")));
    subscriptions.event(summary.clone());
    subscriptions.event(changed.clone());
    subscriptions.observe("phone", &json!({"method":"host.call","params":{"hostId":"beta","method":"session.open","params":{"sessionId":"same"}}}));
    subscriptions.event(detail(Some("beta")));
    assert_eq!(
        subscriptions.0["phone"].pending,
        vec![summary, changed, detail(Some("beta"))]
    );
    assert_eq!(subscriptions.0["phone"].host.as_deref(), Some("beta"));
    subscriptions.observe(
        "phone",
        &json!({"method":"session.sync","params":{"sessionId":"same"}}),
    );
    assert!(subscriptions.0["phone"].host.is_none());
    assert_eq!(subscriptions.0["phone"].pending.len(), 2);
}

#[test]
fn no_selection_does_not_subscribe_to_unscoped_events_or_any_history() {
    let mut subscriptions = Subscriptions::default();
    subscriptions.observe(
        "phone",
        &json!({"type":"remote_select","hostId":"alpha","sessionId":null}),
    );
    subscriptions.event(detail(Some("alpha")));
    subscriptions.event(json!({"type":"settings_changed"}));
    assert!(subscriptions.0["phone"].pending.is_empty());
    subscriptions
        .event(json!({"type":"host_event","hostId":"alpha","event":{"type":"remote_resync"}}));
    assert_eq!(subscriptions.0["phone"].pending.len(), 1);
}

#[test]
fn host_scoped_events_retain_batch_compression_and_overflow_resync() {
    let mut subscriptions = Subscriptions::default();
    subscriptions.observe("phone", &json!({"type":"remote_select","hostId":"alpha","sessionId":"same","acceptEncoding":"gzip"}));
    subscriptions.event(detail(Some("alpha")));
    let (tx, mut rx) = tokio::sync::mpsc::channel(2);
    subscriptions.flush(&tx);
    let batch = rx.try_recv().unwrap();
    assert!(batch.compress);
    assert_eq!(batch.payload["items"][0], detail(Some("alpha")));
    for _ in 0..4097 {
        subscriptions.event(detail(Some("alpha")));
    }
    subscriptions.flush(&tx);
    assert_eq!(
        rx.try_recv().unwrap().payload,
        json!({"type":"remote_resync"})
    );
}
