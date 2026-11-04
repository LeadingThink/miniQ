//! Modal edits have their own input; opening a dialog never consumes a chat draft.
use super::{
    editor::{Action, Editor},
    jobs::Effect,
    requests::Request,
    Repl,
};
use crate::client::Client;
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::{
    layout::Rect,
    style::Style,
    widgets::{Block, Clear, Paragraph},
    Frame,
};
use serde_json::{json, Value};

pub struct Form {
    pub id: u64,
    pub title: String,
    pub editor: Editor,
    pub action: FormAction,
    pub error: Option<String>,
}

#[derive(Clone)]
pub enum FormAction {
    Rename(String),
    Rewrite(Value),
    QueueEdit(Value),
    Attach,
    Mcp,
    Export,
}

pub struct Confirmation {
    pub label: String,
    pub effect: Effect,
    pub request: Request,
    pub form: Option<Form>,
}

impl Form {
    pub fn draw(&self, frame: &mut Frame) {
        let size = frame.area();
        let area = Rect::new(
            2,
            2,
            size.width.saturating_sub(4),
            size.height.saturating_sub(4),
        );
        if area.width < 8 || area.height < 7 {
            return;
        }
        frame.render_widget(Clear, area);
        frame.render_widget(
            Block::default().style(Style::default().bg(super::text::PANEL)),
            area,
        );
        frame.render_widget(
            Paragraph::new(self.title.clone()).style(Style::default().fg(super::text::ACCENT)),
            Rect::new(area.x + 2, area.y + 1, area.width - 4, 1),
        );
        let (lines, cursor) = super::text::input(&self.editor.view(""), (area.width - 4) as usize);
        let height = (area.height - 5) as usize;
        let top = cursor.0.saturating_sub(height.saturating_sub(1));
        frame.render_widget(
            Paragraph::new(lines.into_iter().skip(top).take(height).collect::<Vec<_>>()),
            Rect::new(area.x + 2, area.y + 3, area.width - 4, height as u16),
        );
        frame.render_widget(
            Paragraph::new(
                self.error
                    .clone()
                    .unwrap_or_else(|| "enter save · shift+enter newline · esc cancel".into()),
            )
            .style(Style::default().fg(super::text::MUTED)),
            Rect::new(area.x + 2, area.bottom() - 1, area.width - 4, 1),
        );
        frame.set_cursor_position((
            area.x + 2 + cursor.1.min((area.width - 5) as usize) as u16,
            area.y + 3 + (cursor.0 - top) as u16,
        ));
    }
}

impl Repl {
    pub(super) fn form(&mut self, title: &str, text: &str, action: FormAction) {
        let mut editor = Editor::new(vec![], self.working_directory());
        editor.set_buffer(text);
        self.form_sequence += 1;
        self.ui.form = Some(Form {
            id: self.form_sequence,
            title: title.into(),
            editor,
            action,
            error: None,
        });
    }

    pub(super) async fn form_key(
        &mut self,
        client: &mut Client,
        key: KeyEvent,
    ) -> anyhow::Result<()> {
        if key.code == KeyCode::Esc {
            self.ui.form = None;
            return Ok(());
        }
        let Some(mut form) = self.ui.form.take() else {
            return Ok(());
        };
        let old = form.editor.buffer().to_owned();
        if let Action::Submit(text) = form.editor.key(key) {
            let action = form.action.clone();
            form.editor.set_buffer(&old);
            match self.submit_form(client, action, text).await {
                Err(error) => {
                    form.error = Some(error.to_string());
                    self.ui.form = Some(form);
                }
                Ok(Some(id)) => {
                    self.form_retries.insert(id, form);
                }
                Ok(None) => {
                    if let Some(confirmation) = self.confirmation.as_mut() {
                        confirmation.form = Some(form);
                    }
                }
            }
        } else {
            self.ui.form = Some(form);
        }
        Ok(())
    }

    async fn submit_form(
        &mut self,
        _client: &mut Client,
        action: FormAction,
        text: String,
    ) -> anyhow::Result<Option<u64>> {
        let id = match action {
            FormAction::Rename(id) => {
                anyhow::ensure!(!text.trim().is_empty(), "Enter a title");
                Some(self.rpc(
                    "Renaming session",
                    Effect::Notice("Session renamed".into()),
                    "session.rename",
                    json!({"sessionId":id,"title":text}),
                ))
            }
            FormAction::QueueEdit(item) => {
                anyhow::ensure!(!text.trim().is_empty(), "Enter a message");
                Some(self.rpc("Updating queued message", Effect::Notice("Queued message updated".into()), "session.queueUpdate",
                    json!({"sessionId":self.session,"queuedMessageId":item["id"],"expectedContent":item["content"],
                        "expectedAttachments":item["attachments"],"content":text})))
            }
            FormAction::Rewrite(message) => {
                anyhow::ensure!(!text.trim().is_empty(), "Enter a message");
                self.confirm("Replace this message and rerun from it? Later replies will be removed.",
                    Effect::Notice("Message rewritten".into()), Request::Rpc { method: "session.rewriteMessage".into(),
                    params: json!({"sessionId":self.session,"messageId":message["id"],"message":{"content":text,
                        "attachments":message["attachments"].as_array().cloned().unwrap_or_default()}}) });
                None
            }
            FormAction::Attach => {
                let path = super::attachments::path(&text, &self.working_directory());
                crate::sessions::attachments(std::slice::from_ref(&path))?;
                if !self.files.contains(&path) {
                    self.files.push(path);
                }
                None
            }
            FormAction::Mcp => {
                let updated: Value = serde_json::from_str(&text)?;
                Some(self.rpc(
                    "Updating MCP servers",
                    Effect::Notice("MCP settings saved".into()),
                    "mcp.update",
                    updated,
                ))
            }
            FormAction::Export => {
                let path = super::attachments::path(&text, &self.working_directory());
                Some(self.export_session(path)?)
            }
        };
        Ok(id)
    }

    pub(super) fn confirm(&mut self, label: &str, effect: Effect, request: Request) {
        use super::picker::{Item, Picker, Purpose};
        self.confirmation = Some(Confirmation {
            label: label.into(),
            effect,
            request,
            form: None,
        });
        self.ui.picker = Some(Picker::new(
            Purpose::Confirm,
            label,
            vec![
                Item::new("cancel", "Cancel", ""),
                Item::new("confirm", "Confirm", ""),
            ],
            None,
        ));
    }
}
