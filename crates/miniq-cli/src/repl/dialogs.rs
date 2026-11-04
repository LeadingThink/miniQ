//! Populate overlays from the actual daemon catalog and apply the chosen item.
use super::{
    commands,
    editor::Editor,
    picker::{Item, Picker, Purpose},
    Repl,
};
use crate::client::Client;
use anyhow::{Context, Result};
use serde_json::json;

impl Repl {
    pub(super) async fn open_picker(
        &mut self,
        client: &mut Client,
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
            Purpose::Models => {
                let catalog = client.call("model.list", json!({})).await?;
                let items = crate::selection::model_choices(&catalog)?
                    .iter()
                    .map(|choice| Item::new(&choice.id, &choice.label, ""))
                    .collect();
                ("Select model", items, Some(self.model.clone()))
            }
            Purpose::Effort => {
                let state = client
                    .call("session.modelGet", json!({"sessionId":self.session}))
                    .await?;
                let description = client.call("model.describe", json!({"model":state["effective"]["model"],"apiProtocol":state["effective"]["apiProtocol"]})).await?;
                let mut items = vec![Item::new(
                    "default",
                    "Default",
                    "Use the model's default reasoning effort",
                )];
                for effort in description["reasoningEfforts"]
                    .as_array()
                    .context("invalid reasoning capabilities")?
                {
                    let effort = effort.as_str().context("invalid reasoning effort")?;
                    items.push(Item::new(effort, effort, ""));
                }
                ("Reasoning effort", items, Some(self.effort.clone()))
            }
            Purpose::Sessions => {
                let result = crate::sessions::list(client, &self.options, false).await?;
                let mut sessions: Vec<_> = result["sessions"]
                    .as_array()
                    .context("invalid session list")?
                    .iter()
                    .filter(|s| s["archived"] != true && s["external"].is_null())
                    .collect();
                sessions.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
                let items = sessions
                    .into_iter()
                    .map(|s| {
                        let id = s["id"].as_str().context("session ID missing")?;
                        let label = s["title"].as_str().unwrap_or(id);
                        let updated = s["updatedAt"]
                            .as_str()
                            .map(|at| crate::listing::relative(at, time::OffsetDateTime::now_utc()))
                            .unwrap_or_default();
                        Ok(Item::new(
                            id,
                            label,
                            &format!("{} · {updated}", s["status"].as_str().unwrap_or("idle")),
                        ))
                    })
                    .collect::<Result<Vec<_>>>()?;
                ("Switch session", items, Some(self.session.clone()))
            }
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
        };
        self.ui.picker = Some(Picker::new(purpose, title, items, current));
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
                crate::sessions::update_model(client, &self.session, &options).await?;
                self.refresh(client).await;
                self.notice = format!("Selected {value}");
            }
            Purpose::Sessions => {
                if self.running {
                    anyhow::bail!(
                        "wait for this turn to finish or interrupt it before switching sessions"
                    );
                }
                let id = crate::sessions::prepare(client, &self.options, Some(value)).await?;
                commands::switch(self, client, &id).await?;
            }
            Purpose::Permissions => {
                let state = client
                    .call(
                        "session.approval.update",
                        json!({"sessionId":self.session,"mode":value}),
                    )
                    .await?;
                self.mode = state["effective"].as_str().unwrap_or(value).to_owned();
            }
        }
        Ok(None)
    }

    pub(super) async fn earlier(&mut self, client: &mut Client) -> Result<()> {
        let Some(cursor) = self.ui.transcript.next_cursor.clone() else {
            return Ok(());
        };
        let page = client.call("session.history", json!({"sessionId":self.session,"before":cursor,"limit":100,"includePayloads":true})).await?;
        let width = self.ui.transcript_area.width.saturating_sub(1).max(1) as usize;
        let before = self.ui.rows(width, self.style.color).len();
        let top = self.ui.scroll.unwrap_or(self.ui.top);
        self.ui.transcript.prepend(&page);
        let after = self.ui.rows(width, self.style.color).len();
        // Keep the same visible content while earlier records are inserted.
        self.ui.scroll = Some(top.saturating_add(after.saturating_sub(before)));
        Ok(())
    }
}
