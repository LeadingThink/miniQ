use super::transport::Outbound;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

#[derive(Default)]
struct Peer {
    host: Option<String>,
    session: Option<String>,
    compress: bool,
    pending: Vec<Value>,
    bytes: usize,
    resync: bool,
}

#[derive(Default)]
/// Peers by mobile id plus the round-robin cursor: the last peer whose batch
/// was flushed. The outbound queue is shared, so when it fills up the next
/// flush resumes after this peer instead of starving later peers.
pub(super) struct Subscriptions(BTreeMap<String, Peer>, Option<String>);

impl Subscriptions {
    pub fn observe(&mut self, source: &str, value: &Value) {
        let peer = self.0.entry(source.to_string()).or_default();
        peer.compress = value["acceptEncoding"] == "gzip";
        let routed = value["method"] == "host.call";
        let request = if routed { &value["params"] } else { value };
        if value["type"] == "remote_select"
            || matches!(
                request["method"].as_str(),
                Some("session.open" | "session.sync")
            )
        {
            let session = if value["type"] == "remote_select" {
                &value["sessionId"]
            } else {
                &request["params"]["sessionId"]
            };
            peer.host = if value["type"] == "remote_select" || routed {
                request["hostId"].as_str().map(str::to_string)
            } else {
                None
            };
            peer.session = session.as_str().map(str::to_string);
            let host = peer.host.as_deref();
            let session = peer.session.as_deref();
            peer.pending.retain(|event| visible(event, host, session));
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
            if !visible(&event, peer.host.as_deref(), peer.session.as_deref()) {
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
        let start = self.1.clone().unwrap_or_default();
        let ready = |peer: &Peer| !peer.pending.is_empty() || peer.resync;
        let mut order: Vec<String> = self
            .0
            .iter()
            .filter(|(_, peer)| ready(peer))
            .map(|(id, _)| id.clone())
            .collect();
        let split = order.partition_point(|id| *id <= start);
        order.rotate_left(split);
        for id in order {
            let Ok(permit) = sender.try_reserve() else {
                break;
            };
            let peer = self.0.get_mut(&id).expect("peer listed above");
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
            self.1 = Some(id);
        }
    }
}

fn visible(value: &Value, host: Option<&str>, session: Option<&str>) -> bool {
    if value["type"] == "host_changed" {
        return true;
    }
    let (event_host, event) = if value["type"] == "host_event" {
        (value["hostId"].as_str(), &value["event"])
    } else {
        (None, value)
    };
    crate::event_journal::sidebar_event(event)
        || (host == event_host
            && (event["type"] == "remote_resync"
                || (session.is_some() && event["sessionId"].as_str() == session)))
}

#[cfg(test)]
mod tests;
