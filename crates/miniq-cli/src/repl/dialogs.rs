//! Open overlays immediately; populate them when their background request completes.
use super::{
    commands,
    editor::Editor,
    jobs::Effect,
    picker::{Item, Picker, Purpose},
    requests::Request,
    Repl,
};
use crate::client::Client;
use anyhow::{Context, Result};
use serde_json::{json, Value};

impl Repl {
    pub(super) async fn open_picker(
        &mut self,
        _client: &mut Client,
        purpose: Purpose,
    ) -> Result<()> {
        let (title, items, current) = match purpose {
            Purpose::Commands => (
                "Commands",
                commands::list()
                    .iter()
                    .map(|(name, desc)| Item::new(name, desc, name))
                    .collect(),
                None,
            ),
            Purpose::Models => ("Select model", vec![], Some(self.model.clone())),
            Purpose::Effort => ("Reasoning effort", vec![], Some(self.effort.clone())),
            Purpose::Sessions => ("Switch session", vec![], Some(self.session.clone())),
            Purpose::Permissions => (
                "Permissions",
                vec![
                    Item::new(
                        "alwaysAsk",
                        "Ask for approval",
                        "Confirm tool actions before they execute",
                    ),
                    Item::new(
                        "auto",
                        "Automatic",
                        "Use miniQ's risk-based approval policy",
                    ),
                    Item::new(
                        "fullAccess",
                        "Full access",
                        "Run tools without confirmation",
                    ),
                ],
                Some(self.mode.clone()),
            ),
            _ => {
                self.panel(purpose);
                return Ok(());
            }
        };
        let mut picker = Picker::new(purpose, title, items, current);
        if purpose == Purpose::Models {
            picker.hint = "enter select · ctrl+f favorite · ctrl+d details · ctrl+r reload".into();
        }
        if purpose == Purpose::Sessions {
            picker.hint = "enter switch · ctrl+d session actions · ctrl+r reload".into();
        }
        if matches!(
            purpose,
            Purpose::Models | Purpose::Effort | Purpose::Sessions
        ) {
            picker.request = Some(self.request(
                title,
                Effect::Picker(purpose),
                Request::Picker {
                    purpose,
                    options: super::copy_options(&self.options),
                },
            ));
            picker.loading = true;
        }
        self.ui.picker = Some(picker);
        Ok(())
    }

    pub(super) async fn choose(
        &mut self,
        editor: &mut Editor,
        client: &mut Client,
        value: &str,
    ) -> Result<Option<u8>> {
        let Some(picker) = self.ui.picker.take() else {
            return Ok(None);
        };
        match picker.purpose {
            Purpose::Commands => return commands::run(self, editor, client, value).await,
            Purpose::Models | Purpose::Effort => {
                let options = crate::args::ChatOptions {
                    model: (picker.purpose == Purpose::Models).then(|| value.to_owned()),
                    effort: (picker.purpose == Purpose::Effort).then(|| value.to_owned()),
                    ..Default::default()
                };
                self.request("Updating model", Effect::Model, Request::Model(options));
            }
            Purpose::Sessions => commands::switch(self, client, value).await?,
            Purpose::Permissions => {
                self.rpc(
                    "Updating permissions",
                    Effect::Permissions,
                    "session.approval.update",
                    json!({"sessionId":self.session,"mode":value}),
                );
            }
            purpose => self.choose_panel(editor, client, purpose, value).await?,
        }
        Ok(None)
    }

    pub(super) fn picker_items(&self, purpose: Purpose, value: &Value) -> Result<Vec<Item>> {
        Ok(match purpose {
            Purpose::Models => {
                let mut choices = crate::selection::model_choices(value)?;
                choices.sort_by_key(|choice| {
                    (
                        !self.preferences.favorite_models.contains(&choice.id),
                        self.preferences
                            .recent_models
                            .iter()
                            .position(|id| id == &choice.id)
                            .unwrap_or(usize::MAX),
                    )
                });
                choices
                    .iter()
                    .map(|choice| {
                        Item::new(
                            &choice.id,
                            &format!(
                                "{}{}",
                                if self.preferences.favorite_models.contains(&choice.id) {
                                    "★ "
                                } else {
                                    ""
                                },
                                choice.label
                            ),
                            if self.preferences.recent_models.contains(&choice.id) {
                                "Recently used"
                            } else {
                                ""
                            },
                        )
                    })
                    .collect()
            }
            Purpose::Effort => {
                let mut items = vec![Item::new(
                    "default",
                    "Default",
                    "Use the model's default reasoning effort",
                )];
                for effort in value["reasoningEfforts"]
                    .as_array()
                    .context("invalid reasoning capabilities")?
                {
                    let effort = effort.as_str().context("invalid reasoning effort")?;
                    items.push(Item::new(effort, effort, ""));
                }
                items
            }
            Purpose::Sessions => {
                let mut sessions: Vec<_> = value["sessions"]
                    .as_array()
                    .context("invalid session list")?
                    .iter()
                    .filter(|session| session["archived"] != true && session["external"].is_null())
                    .collect();
                sessions.sort_by(|a, b| {
                    b["pinned"]
                        .as_bool()
                        .cmp(&a["pinned"].as_bool())
                        .then_with(|| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()))
                });
                sessions
                    .into_iter()
                    .map(|session| {
                        let id = session["id"].as_str().context("session ID missing")?;
                        Ok(Item::new(
                            id,
                            session["title"].as_str().unwrap_or(id),
                            &format!(
                                "{} · {}\n{}",
                                session["status"].as_str().unwrap_or("idle"),
                                session["updatedAt"].as_str().unwrap_or(""),
                                session["workingDirectory"].as_str().unwrap_or("")
                            ),
                        ))
                    })
                    .collect::<Result<Vec<_>>>()?
            }
            _ => self.resource_items(purpose, value),
        })
    }

    pub(super) async fn earlier(&mut self, _client: &mut Client) -> Result<()> {
        let Some(cursor) = self.ui.transcript.next_cursor.clone() else {
            return Ok(());
        };
        if self
            .pending_labels
            .values()
            .any(|label| label == "Loading earlier messages")
        {
            return Ok(());
        }
        self.rpc(
            "Loading earlier messages",
            Effect::History,
            "session.history",
            json!({"sessionId":self.session,"before":cursor,"limit":100,"includePayloads":true}),
        );
        Ok(())
    }
}
