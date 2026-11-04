//! Search the durable conversation, with explicit pages and message-level actions.
use super::{
    jobs::Effect,
    picker::{Item, Picker, Purpose},
    Repl,
};
use serde_json::{json, Value};

impl Repl {
    pub(super) fn search_messages(&mut self, query: &str, cursor: Option<Value>) {
        let mut picker = Picker::new(Purpose::Messages, "Messages", vec![], None);
        picker.loading = true;
        picker.query = query.into();
        picker.hint =
            "enter actions · ctrl+f search all history · ctrl+h earlier results · ctrl+r newest"
                .into();
        picker.request = Some(self.rpc("Searching messages", Effect::MessagePage(query.into()), "session.history",
            json!({"sessionId":self.session,"query":query,"filter":"answers","limit":100,"before":cursor})));
        self.ui.picker = Some(picker);
    }

    pub(super) fn message(&self, id: &str) -> Option<Value> {
        self.ui
            .transcript
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .and_then(|entry| entry.message.clone())
            .or_else(|| {
                self.catalogs
                    .get(&Purpose::Messages)
                    .and_then(|catalog| catalog["messages"].as_array())
                    .and_then(|messages| messages.iter().find(|message| message["id"] == id))
                    .cloned()
            })
    }

    pub(super) fn message_page(&mut self, id: u64, query: String, value: Value) {
        if !self
            .ui
            .picker
            .as_ref()
            .is_some_and(|picker| picker.request == Some(id))
        {
            return;
        }
        let items = value["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .map(|message| {
                Item::new(
                    message["id"].as_str().unwrap_or(""),
                    &format!(
                        "{} · {}",
                        message["role"].as_str().unwrap_or("message"),
                        message["createdAt"].as_str().unwrap_or("")
                    ),
                    message["content"].as_str().unwrap_or(""),
                )
            })
            .collect();
        let mut catalog = value;
        catalog["query"] = json!(query);
        self.catalogs.insert(Purpose::Messages, catalog);
        let picker = self.ui.picker.as_mut().unwrap();
        picker.items = items;
        picker.loading = false;
    }
}
