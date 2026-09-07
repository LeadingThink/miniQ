use super::transport::Outbound;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct Peer {
    session: Option<String>,
    compress: bool,
    pending: Vec<Value>,
    bytes: usize,
    resync: bool,
}

#[derive(Default)]
pub(super) struct Subscriptions(HashMap<String, Peer>);

impl Subscriptions {
    pub fn observe(&mut self, source: &str, value: &Value) {
        let peer = self.0.entry(source.to_string()).or_default();
        peer.compress = value["acceptEncoding"] == "gzip";
        if value["type"] == "remote_select"
            || matches!(
                value["method"].as_str(),
                Some("session.open" | "session.sync")
            )
        {
            let session = if value["type"] == "remote_select" {
                &value["sessionId"]
            } else {
                &value["params"]["sessionId"]
            };
            peer.session = session.as_str().map(str::to_string);
            peer.pending.retain(|event| {
                crate::event_journal::sidebar_event(event)
                    || event["sessionId"].as_str() == peer.session.as_deref()
            });
            peer.bytes = peer
                .pending
                .iter()
                .map(|value| value.to_string().len())
                .sum();
        }
    }

    pub fn retain(&mut self, ids: &[String]) {
        let ids: HashSet<_> = ids.iter().collect();
        self.0.retain(|id, _| ids.contains(id));
    }

    pub fn event(&mut self, event: Value) {
        let size = event.to_string().len();
        for peer in self.0.values_mut() {
            if peer.resync {
                continue;
            }
            if !crate::event_journal::sidebar_event(&event)
                && event["sessionId"].as_str() != peer.session.as_deref()
            {
                continue;
            }
            peer.bytes += size;
            peer.pending.push(event.clone());
            if peer.pending.len() > 4096 || peer.bytes > 8 * 1024 * 1024 {
                peer.pending.clear();
                peer.bytes = 0;
                peer.resync = true;
            }
        }
    }

    pub fn resync(&mut self) {
        for peer in self.0.values_mut() {
            peer.pending.clear();
            peer.bytes = 0;
            peer.resync = true;
        }
    }

    pub fn flush(&mut self, sender: &tokio::sync::mpsc::Sender<Outbound>) {
        for (id, peer) in &mut self.0 {
            if peer.pending.is_empty() && !peer.resync {
                continue;
            }
            let Ok(permit) = sender.try_reserve() else {
                return;
            };
            let payload = if peer.resync {
                json!({"type":"remote_resync"})
            } else {
                json!({"type":"remote_batch", "items": std::mem::take(&mut peer.pending)})
            };
            let mut outbound = Outbound::new(id.clone(), payload);
            outbound.compress = peer.compress;
            permit.send(outbound);
            peer.bytes = 0;
            peer.resync = false;
        }
    }
}
