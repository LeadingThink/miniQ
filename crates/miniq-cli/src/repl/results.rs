//! Apply completed operations to their originating session and overlay.
use super::{
    editor::Editor,
    jobs::{Completion, Effect},
    requests::Request,
    Repl,
};
use crate::client::Client;
use serde_json::Value;

impl Repl {
    pub(super) fn complete(
        &mut self,
        editor: &mut Editor,
        client: &mut Client,
        mut completed: Completion,
    ) {
        if matches!(completed.effect, Effect::Sent { .. })
            && completed
                .result
                .as_ref()
                .is_ok_and(|v| v["cancelled"] == true)
        {
            completed.result = Err(anyhow::anyhow!("send cancelled; draft recovered"));
        }
        if !self.prepare_completion(editor, &completed) {
            return;
        }
        if matches!(completed.effect, Effect::Switch) {
            if self.switch_request != Some(completed.id) {
                return;
            }
            self.switch_request = None;
            client.clear_watch();
        } else if completed.session != self.session
            && !matches!(completed.effect, Effect::SessionRemoved(_))
        {
            self.complete_inactive(completed);
            return;
        }
        let value = match completed.result {
            Ok(value) => value,
            Err(error) => {
                self.failed_completion(editor, completed.id, &completed.effect, &error);
                self.error(&format!("{}: {error:#}", completed.label));
                return;
            }
        };
        match completed.effect {
            Effect::Switch => {
                let Some(id) = value["session"]["id"].as_str() else {
                    self.error("session ID missing");
                    return;
                };
                self.save_draft(editor);
                self.session = id.into();
                self.running = false;
                self.started = None;
                self.context_percent = None;
                self.catalogs.clear();
                self.ui.reader = None;
                self.ui.form = None;
                self.confirmation = None;
                client.scope(id);
                client.accept_snapshot(&value);
                self.apply_snapshot(&value);
                self.replay_snapshot(&value);
                self.load_draft(editor);
                self.ui.picker = None;
            }
            Effect::Refresh => {
                let scroll = self.ui.scroll;
                client.accept_snapshot(&value);
                self.apply_snapshot(&value);
                self.replay_snapshot(&value);
                self.ui.scroll = scroll;
            }
            Effect::History => {
                let width = self.ui.transcript_area.width.saturating_sub(1).max(1) as usize;
                let before = self.ui.rows(width, self.style.color).len();
                let top = self.ui.scroll.unwrap_or(self.ui.top);
                self.ui.transcript.prepend(&value);
                let after = self.ui.rows(width, self.style.color).len();
                self.ui.scroll = Some(top + after.saturating_sub(before));
            }
            Effect::Context => self.context_percent = value["percentUsed"].as_f64(),

            Effect::Sent { .. } => {
                if let Some(id) = value["queued"].as_str() {
                    self.info(&format!("Queued: {id}"));
                }
                if let Some(error) = value["steerError"].as_str() {
                    self.error(&format!("Prompt was queued, but steering could not be confirmed: {error}. Check /queue before retrying."));
                }
                self.ui.scroll = None;
            }
            Effect::SessionRemoved(id) => {
                self.info("Session removed from active conversations");
                if id == self.session {
                    self.switch_request = Some(self.request(
                        "Opening a new session",
                        Effect::Switch,
                        Request::New(super::copy_options(&self.options)),
                    ));
                }
            }
            effect => self.complete_view(editor, completed.id, effect, value),
        }
    }

    fn prepare_completion(&mut self, editor: &mut Editor, completed: &Completion) -> bool {
        self.pending_labels.remove(&completed.id);
        if let Effect::Resolved { id, answer } = &completed.effect {
            self.resolving_cards.retain(|pending| pending != id);
            if completed.result.is_err() {
                if let Some(answer) = answer {
                    if completed.session == self.session && editor.is_empty() {
                        editor.set_buffer(answer);
                    } else {
                        self.drafts.insert(
                            format!("answer:{}:{}", completed.session, completed.id),
                            super::drafts::Draft {
                                text: answer.clone(),
                                cursor: answer.len(),
                                ..Default::default()
                            },
                        );
                    }
                }
            }
        }
        if matches!(completed.effect, Effect::Refresh) {
            if self.refresh_request != Some(completed.id) {
                return false;
            }
            self.refresh_request = None;
        }
        if let Some(mut form) = self.form_retries.remove(&completed.id) {
            if let Err(error) = &completed.result {
                form.error = Some(format!("{error:#}"));
                if completed.session == self.session && self.ui.form.is_none() {
                    self.ui.form = Some(form);
                } else {
                    self.drafts.insert(
                        format!("edit:{}:{}", completed.session, completed.id),
                        super::drafts::Draft {
                            text: form.editor.buffer().into(),
                            cursor: form.editor.cursor(),
                            ..Default::default()
                        },
                    );
                }
            }
        }
        true
    }

    fn failed_completion(
        &mut self,
        editor: &mut Editor,
        id: u64,
        effect: &Effect,
        error: &anyhow::Error,
    ) {
        if let Some(reader) = self
            .ui
            .reader
            .as_mut()
            .filter(|reader| reader.request == Some(id))
        {
            reader.error = Some(format!("{error:#}"));
            reader.request = None;
        }
        if let Some(picker) = self
            .ui
            .picker
            .as_mut()
            .filter(|picker| picker.request == Some(id))
        {
            picker.loading = false;
            picker.error = Some(format!("{error:#}"));
        }
        if let Effect::Sent { text, files } = effect {
            if editor.is_empty() {
                editor.set_buffer(text);
                for file in files {
                    if !self.files.contains(file) {
                        self.files.push(file.clone());
                    }
                }
            } else {
                self.save_unsent(id, &self.session.clone(), text, files);
            }
        }
    }

    pub(super) fn save_unsent(
        &mut self,
        id: u64,
        session: &str,
        text: &str,
        files: &[std::path::PathBuf],
    ) {
        self.drafts.insert(
            format!("unsent:{session}:{id}"),
            super::drafts::Draft {
                cursor: text.len(),
                text: text.into(),
                files: files.to_vec(),
                ..Default::default()
            },
        );
    }

    fn complete_inactive(&mut self, completed: Completion) {
        match (&completed.effect, &completed.result) {
            (Effect::Sent { text, files }, Err(_)) => {
                self.save_unsent(completed.id, &completed.session, text, files)
            }
            (Effect::Clipboard(_), Ok(value)) => {
                let draft = self.drafts.entry(completed.session.clone()).or_default();
                if let Some(image) = value["image"].as_str() {
                    draft.files.push(image.into());
                }
                if let Some(text) = value["text"].as_str() {
                    draft.text.push_str(text);
                    draft.cursor = draft.text.len();
                }
            }
            _ => {}
        }
        if let Err(error) = completed.result {
            self.error(&format!(
                "{} · {}: {error:#}",
                completed.session, completed.label
            ));
        }
    }

    pub(super) fn apply_model(&mut self, value: &Value) {
        self.model = value["effective"]["model"]
            .as_str()
            .unwrap_or("default")
            .into();
        self.effort = value["effective"]["reasoningEffort"]
            .as_str()
            .unwrap_or("default")
            .into();
    }

    fn apply_snapshot(&mut self, value: &Value) {
        self.restore(value);
        self.ui.selection = None;
        for (id, process) in self
            .processes
            .items
            .iter()
            .filter(|(_, process)| process.session == self.session)
        {
            self.ui.transcript.local_output(
                &format!("local:{id}"),
                &format!("$ {}\n{}", process.title, process.output),
            );
        }
        if let Some(path) = value["session"]["workingDirectory"].as_str() {
            self.options.directory = Some(path.into());
        }
        if !value["modelSelection"].is_null() {
            self.apply_model(&value["modelSelection"]);
        }
        if let Some(mode) = value["permissionSelection"]["effective"].as_str() {
            self.mode = mode.into();
        }
        self.context_stale = true;
    }

    pub(super) fn show_detail(&mut self, title: &str, text: &str) {
        self.ui.reader = Some(super::reader::Reader::new(title, text));
    }

    fn replay_snapshot(&mut self, snapshot: &Value) {
        let events = std::mem::take(&mut self.snapshot_events);
        for event in events {
            if event["sessionId"].as_str() == Some(&self.session)
                && crate::client::after_snapshot(&event, snapshot.get("eventCursor"))
            {
                if self.event(&event) {
                    self.history_stale = true;
                }
            }
            if self.switch_request.is_some() {
                self.snapshot_events.push(event);
            }
        }
    }
}
