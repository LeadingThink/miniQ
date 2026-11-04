//! Contextual shortcuts for list panels. All remote work stays in background jobs.
use super::{jobs::Effect, picker::Purpose, Editor, Repl};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;

impl Repl {
    pub(super) async fn panel_key(
        &mut self,
        editor: &mut Editor,
        client: &mut crate::client::Client,
        key: KeyEvent,
    ) -> anyhow::Result<bool> {
        if key.code == KeyCode::Char('c') && key.modifiers == KeyModifiers::CONTROL {
            if let Some(id) = self.ui.reader.as_ref().and_then(|reader| reader.process) {
                self.processes.cancel_id(id);
                return Ok(true);
            }
        }
        if key.code == KeyCode::Char('o') && key.modifiers.is_empty() {
            if let Some(path) = self
                .ui
                .reader
                .as_ref()
                .filter(|reader| !reader.searching)
                .and_then(|reader| reader.file.as_ref())
            {
                super::platform::open(path)?;
                return Ok(true);
            }
        }
        if key.modifiers != KeyModifiers::CONTROL {
            return Ok(false);
        }
        if self.ui.reader.is_some() && key.code == KeyCode::Char('r') {
            self.refresh_reader();
            return Ok(true);
        }
        if key.code == KeyCode::Char('v') {
            self.request(
                "Reading clipboard",
                Effect::Clipboard(self.ui.form.as_ref().map(|form| form.id)),
                super::requests::Request::Clipboard(self.prefs_dir.join("clipboard")),
            );
            return Ok(true);
        }
        if key.code == KeyCode::Char('y') {
            let text = self
                .ui
                .reader
                .as_ref()
                .map(|reader| reader.body.clone())
                .or_else(|| self.ui.selected_text());
            if let Some(text) = text {
                self.copy_selection(&crate::output::terminal_text(&text));
                return Ok(true);
            }
        }
        let Some(picker) = self.ui.picker.as_ref() else {
            return Ok(false);
        };
        let purpose = picker.purpose;
        let selected = picker.selected_value();
        match key.code {
            KeyCode::Char('r') => {
                self.open_picker(client, purpose).await?;
            }
            KeyCode::Char('h') if purpose == Purpose::Messages => {
                if let Some(catalog) = self.catalogs.get(&purpose) {
                    if let Some(cursor) = catalog
                        .get("nextCursor")
                        .filter(|cursor| !cursor.is_null())
                        .cloned()
                    {
                        self.search_messages(
                            &catalog["query"].as_str().unwrap_or("").to_owned(),
                            Some(cursor),
                        );
                    }
                }
            }
            KeyCode::Char('f') if purpose == Purpose::Messages => {
                self.search_messages(&self.ui.picker.as_ref().unwrap().query.clone(), None);
            }
            KeyCode::Char('h') if purpose == Purpose::AgentHistory => {
                if let Some(cursor) = self
                    .catalogs
                    .get(&purpose)
                    .and_then(|value| value.get("nextCursor"))
                    .filter(|value| !value.is_null())
                    .cloned()
                {
                    self.agent_history(&self.panel_target.clone(), Some(cursor));
                }
            }
            KeyCode::Char('n') if purpose == Purpose::Attachments => {
                self.form("Attach a file", "", super::forms::FormAction::Attach)
            }
            KeyCode::Char('f') if purpose == Purpose::Models => {
                if let Some(id) = selected {
                    if self.preferences.favorite_models.contains(&id) {
                        self.preferences
                            .favorite_models
                            .retain(|value| value != &id);
                    } else {
                        self.preferences.favorite_models.push(id);
                    }
                    self.save_preferences()?;
                    let items = self.picker_items(purpose, &self.catalogs[&purpose])?;
                    if let Some(picker) = self.ui.picker.as_mut() {
                        picker.items = items;
                    }
                }
            }
            KeyCode::Char('d') => {
                if let Some(id) = selected {
                    match purpose {
                        Purpose::Sessions => self.session_actions(&id),
                        Purpose::Models => {
                            self.remote_detail(
                                &id,
                                "model.describe",
                                json!({"model":id,"apiProtocol":self.options.protocol.as_deref().unwrap_or("auto")}),
                                false,
                            );
                        }
                        Purpose::Tools => {
                            self.inspect_tool(&id, true);
                        }
                        _ => {
                            self.choose(editor, client, &id).await?;
                        }
                    }
                }
            }
            _ => return Ok(false),
        }
        Ok(true)
    }
}
