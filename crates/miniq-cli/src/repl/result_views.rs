//! Apply completed operations to their originating session and overlay.
use super::{editor::Editor, jobs::Effect, Repl};
use serde_json::Value;

impl Repl {
    pub(super) fn complete_view(
        &mut self,
        editor: &mut Editor,
        id: u64,
        effect: Effect,
        value: Value,
    ) {
        if matches!(effect, Effect::Undo) && editor.is_empty() {
            if let Some(text) = value["removedMessage"]["content"].as_str() {
                editor.set_buffer(text);
            }
        }
        match effect {
            Effect::MessagePage(query) => self.message_page(id, query, value),
            Effect::Locate(id) => {
                self.ui.transcript.prepend(&value);
                self.ui.rows(
                    self.ui.transcript_area.width.saturating_sub(1).max(1) as usize,
                    self.style.color,
                );
                self.ui.jump_to(&id);
            }
            Effect::Reader => {
                if let Some(reader) = self
                    .ui
                    .reader
                    .as_mut()
                    .filter(|reader| reader.request == Some(id))
                {
                    reader.body = crate::output::terminal_text(
                        &serde_json::to_string_pretty(&value).unwrap_or_default(),
                    );
                    reader.request = None;
                    reader.refreshed = std::time::Instant::now();
                }
            }
            Effect::Tool { id, detail } => {
                if let Some(entry) = self
                    .ui
                    .transcript
                    .entries
                    .iter_mut()
                    .find(|entry| entry.id == id)
                {
                    entry.tool = Some(value.clone());
                    self.ui.transcript.version += 1;
                }
                if detail {
                    self.show_detail(&id, &super::tool_view::details(&value, self.style));
                }
            }
            Effect::Clipboard(target) => {
                if let Some(path) = value["image"].as_str() {
                    self.files.push(path.into());
                    self.notice = "Clipboard image attached · /attachments to preview".into();
                } else if let Some(text) = value["text"].as_str() {
                    if let Some(form) = self.ui.form.as_mut().filter(|form| Some(form.id) == target)
                    {
                        form.editor.paste(text);
                    } else if target.is_none() {
                        editor.paste(text);
                    } else {
                        self.save_unsent(id, &self.session.clone(), text, &[]);
                        self.notice =
                            "Clipboard text saved in /drafts; the original form was closed".into();
                    }
                }
            }
            Effect::Preview(title) => {
                self.show_detail(&title, value["text"].as_str().unwrap_or(""));
                let reader = self.ui.reader.as_mut().unwrap();
                reader.image = super::image_preview::ImagePreview::from_value(&value["image"]);
                reader.file = value["path"].as_str().map(Into::into);
            }
            effect => self.complete_settings(id, effect, value),
        }
    }
    fn complete_settings(&mut self, id: u64, effect: Effect, value: Value) {
        match effect {
            Effect::Picker(purpose) => {
                if !self
                    .ui
                    .picker
                    .as_ref()
                    .is_some_and(|picker| picker.request == Some(id))
                {
                    return;
                }
                self.catalogs.insert(purpose, value.clone());
                let items = self.picker_items(purpose, &value);
                if let Some(picker) = self
                    .ui
                    .picker
                    .as_mut()
                    .filter(|picker| picker.request == Some(id))
                {
                    picker.loading = false;
                    match items {
                        Ok(items) => {
                            picker.selected = picker
                                .current
                                .as_ref()
                                .and_then(|id| items.iter().position(|item| &item.value == id))
                                .unwrap_or(0);
                            picker.items = items;
                        }
                        Err(error) => picker.error = Some(error.to_string()),
                    }
                }
            }
            Effect::Detail(title) => {
                let body = if title == "Model usage" {
                    super::commands::usage(&value)
                } else if let Some(content) = value["content"].as_str() {
                    content.into()
                } else {
                    serde_json::to_string_pretty(&value).unwrap_or_default()
                };
                self.show_detail(&title, &body);
            }
            Effect::Model => {
                self.apply_model(&value);
                self.preferences
                    .recent_models
                    .retain(|id| id != &self.model);
                self.preferences.recent_models.insert(0, self.model.clone());
                if !self.prefs_dir.as_os_str().is_empty() {
                    if let Err(error) = self.save_preferences() {
                        self.error(&format!("Saving preferences: {error:#}"));
                    }
                }
            }
            Effect::Permissions => {
                if let Some(mode) = value["effective"].as_str().or(value["mode"].as_str()) {
                    self.mode = mode.into();
                }
            }
            effect => self.complete_action(effect, value),
        }
    }
    fn complete_action(&mut self, effect: Effect, value: Value) {
        match effect {
            Effect::Resolved { id, .. } => {
                self.cards.retain(|card| card.id() != &id);
                self.ui.card_selected = 0;
                self.ui.card_offset = 0;
                self.ui.card_checked.clear();
            }
            Effect::Notice(message) => self.info(&message),
            Effect::Copied => {
                self.notice = if value["native"] == true {
                    "Copied to clipboard".into()
                } else {
                    "Copy sent to terminal (OSC 52); terminal clipboard permission is required"
                        .into()
                }
            }
            Effect::Undo => {
                self.history_stale = true;
                self.context_stale = true;
                self.info("Prompt undone. /redo restores this exchange.");
                if let Some(files) = value["restoredFiles"]
                    .as_array()
                    .filter(|files| !files.is_empty())
                {
                    self.info(&format!("Restored {} file(s).", files.len()));
                }
                if let Some(error) = value["redoError"].as_str() {
                    self.error(&format!("Redo unavailable: {error}"));
                }
                if value["failedFiles"]
                    .as_array()
                    .is_some_and(|files| !files.is_empty())
                {
                    self.error(&format!(
                        "Some files could not be restored:\n{}",
                        serde_json::to_string_pretty(&value["failedFiles"]).unwrap_or_default()
                    ));
                }
            }

            _ => unreachable!("state and view completions are handled before actions"),
        }
    }
}
