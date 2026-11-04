//! Agent history pages contain metadata; full messages are fetched by revision/index.
use super::{
    jobs::Effect,
    picker::{Item, Picker, Purpose},
    Repl,
};
use serde_json::{json, Value};

impl Repl {
    pub(super) fn agent_history(&mut self, agent: &str, cursor: Option<Value>) {
        self.panel_target = agent.into();
        let mut picker = Picker::new(
            Purpose::AgentHistory,
            &format!("Agent {agent} history"),
            vec![],
            None,
        );
        picker.loading = true;
        picker.hint =
            "enter full message · ctrl+h earlier page · ctrl+r newest page · esc close".into();
        picker.request = Some(self.rpc(
            "Loading agent history",
            Effect::Picker(Purpose::AgentHistory),
            "agent.history",
            json!({"sessionId":self.session,"agentId":agent,"cursor":cursor,"limit":50}),
        ));
        self.ui.picker = Some(picker);
    }

    pub(super) fn agent_items(&self, value: &Value) -> Vec<Item> {
        value["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|entry| {
                Item::new(
                    &entry["index"].to_string(),
                    &format!(
                        "{} · {}",
                        entry["index"],
                        entry["role"].as_str().unwrap_or("message")
                    ),
                    &format!(
                        "{} characters · {} tools · {} images",
                        entry["textCharacters"], entry["toolCount"], entry["imageCount"]
                    ),
                )
            })
            .collect()
    }
}
