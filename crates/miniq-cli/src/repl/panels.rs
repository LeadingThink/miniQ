//! Lists for conversation navigation and live daemon resources.
use super::{
    forms::FormAction,
    jobs::Effect,
    picker::{Item, Picker, Purpose},
    requests::Request,
    transcript::Kind,
    Repl,
};
use crate::client::Client;
use anyhow::Result;
use serde_json::{json, Value};

impl Repl {
    pub(super) fn panel(&mut self, purpose: Purpose) {
        if purpose == Purpose::Messages {
            self.search_messages("", None);
            return;
        }
        if purpose == Purpose::AgentHistory {
            self.agent_history(&self.panel_target.clone(), None);
            return;
        }
        let title = match purpose {
            Purpose::Messages => "Messages",
            Purpose::Tools => "Tools",
            Purpose::Queue => "Queued messages",
            Purpose::Agents => "Subagents",
            Purpose::Attachments => "Attachments",
            Purpose::Mcp => "MCP servers",
            Purpose::Skills => "Skills",
            Purpose::Drafts => "Saved drafts",
            Purpose::Processes => "Local commands",
            Purpose::Diff => "Changed files",
            Purpose::Settings => "Terminal settings",
            Purpose::Themes => "Theme",
            _ => "Actions",
        };
        let items = self.local_items(purpose);
        let mut picker = Picker::new(purpose, title, items, None);
        if matches!(
            purpose,
            Purpose::Queue | Purpose::Agents | Purpose::Mcp | Purpose::Skills | Purpose::Diff
        ) {
            picker.loading = true;
            picker.request = Some(self.request(
                title,
                Effect::Picker(purpose),
                Request::Picker {
                    purpose,
                    options: super::copy_options(&self.options),
                },
            ));
        }
        picker.hint = match purpose {
            Purpose::Messages => "enter actions · ctrl+h earlier messages · esc close",
            Purpose::Tools => "enter expand/collapse · ctrl+d full details · esc close",
            Purpose::Attachments => "enter actions · ctrl+n add path · ctrl+v paste · esc close",
            _ => "↑↓ select · enter open · ctrl+r refresh · esc close",
        }
        .into();
        self.ui.picker = Some(picker);
    }

    fn local_items(&self, purpose: Purpose) -> Vec<Item> {
        match purpose {
            Purpose::Tools => self
                .ui
                .transcript
                .entries
                .iter()
                .filter(|entry| entry.kind == Kind::Tool)
                .map(|entry| {
                    Item::new(
                        &entry.id,
                        &entry
                            .tool
                            .as_ref()
                            .map(|tool| {
                                super::render::tool_summary(
                                    tool["toolName"].as_str().unwrap_or("tool"),
                                    &tool["input"],
                                )
                            })
                            .unwrap_or_default(),
                        entry
                            .tool
                            .as_ref()
                            .and_then(|tool| tool["status"].as_str())
                            .unwrap_or(""),
                    )
                })
                .collect(),
            Purpose::Attachments => self
                .files
                .iter()
                .enumerate()
                .map(|(index, path)| {
                    Item::new(
                        &index.to_string(),
                        &path.display().to_string(),
                        "enter: preview / open / remove",
                    )
                })
                .collect(),
            Purpose::Drafts => self
                .drafts
                .iter()
                .map(|(id, draft)| Item::new(id, id, &draft.text))
                .collect(),
            Purpose::Processes => self
                .processes
                .items
                .iter()
                .map(|(id, process)| {
                    Item::new(
                        &id.to_string(),
                        &process.title,
                        if process.done {
                            "Finished"
                        } else {
                            "Running · ctrl+c interrupts in the output view"
                        },
                    )
                })
                .collect(),
            Purpose::Themes => ["dark", "light", "system"]
                .iter()
                .map(|name| Item::new(name, name, ""))
                .collect(),
            Purpose::Settings => vec![
                Item::new("theme", "Theme", "Dark, light or terminal colors"),
                Item::new(
                    "animations",
                    "Animations",
                    if self.preferences.animations {
                        "Enabled"
                    } else {
                        "Disabled"
                    },
                ),
                Item::new(
                    "vim",
                    "Editor mode",
                    if self.preferences.editor_mode == super::prefs::EditorMode::Vim {
                        "Vim"
                    } else {
                        "Emacs"
                    },
                ),
            ],
            _ => vec![],
        }
    }

    pub(super) fn resource_items(&self, purpose: Purpose, value: &Value) -> Vec<Item> {
        if purpose == Purpose::AgentHistory {
            return self.agent_items(value);
        }
        let key = match purpose {
            Purpose::Queue => "queue",
            Purpose::Agents => "agents",
            Purpose::Mcp => "servers",
            Purpose::Skills => "skills",
            Purpose::Diff => "files",
            _ => return vec![],
        };
        value[key]
            .as_array()
            .or(value.as_array())
            .into_iter()
            .flatten()
            .map(|item| {
                let id = item["id"]
                    .as_str()
                    .or(item["name"].as_str())
                    .or(item["path"].as_str())
                    .unwrap_or("");
                let name = item["title"]
                    .as_str()
                    .or(item["name"].as_str())
                    .or(item["path"].as_str())
                    .unwrap_or(id);
                let detail = if purpose == Purpose::Queue {
                    item["content"].as_str().unwrap_or("").into()
                } else {
                    serde_json::to_string_pretty(item).unwrap_or_default()
                };
                Item::new(
                    &resource_id(purpose, item).unwrap_or_else(|| id.into()),
                    name,
                    &detail,
                )
            })
            .collect()
    }

    pub(super) async fn choose_panel(
        &mut self,
        editor: &mut super::Editor,
        client: &mut Client,
        purpose: Purpose,
        value: &str,
    ) -> Result<()> {
        match purpose {
            Purpose::Messages => {
                self.panel_target = value.into();
                let message = self.message(value);
                let mut items = vec![
                    Item::new("jump", "Jump to message", ""),
                    Item::new("copy", "Copy message", ""),
                ];
                if message
                    .as_ref()
                    .is_some_and(|message| message["role"] == "user")
                {
                    items.extend([
                        Item::new("edit", "Edit and rerun", "Later replies are replaced"),
                        Item::new(
                            "undo",
                            "Undo from this message",
                            "Remove this prompt and later replies; restore files",
                        ),
                    ]);
                } else {
                    items.push(Item::new("fork", "Fork from this reply", ""));
                }
                self.ui.picker = Some(Picker::new(
                    Purpose::MessageActions,
                    "Message actions",
                    items,
                    None,
                ));
            }
            Purpose::MessageActions => self.message_action(value)?,
            Purpose::Tools => self.inspect_tool(value, false),
            Purpose::AgentHistory => {
                let revision = self
                    .catalogs
                    .get(&purpose)
                    .map(|value| value["revision"].clone())
                    .unwrap_or(Value::Null);
                self.rpc("Loading full agent message", Effect::Detail(format!("Agent {} · message {value}", self.panel_target)), "agent.message",
                    json!({"sessionId":self.session,"agentId":self.panel_target,"revision":revision,"index":value.parse::<u32>()?}));
            }
            Purpose::Queue | Purpose::Agents | Purpose::Mcp | Purpose::Skills => {
                self.panel_target = value.into();
                self.resource_actions(purpose);
            }
            Purpose::QueueActions
            | Purpose::AgentActions
            | Purpose::McpActions
            | Purpose::SkillActions => self.resource_action(purpose, value)?,
            Purpose::Confirm => {
                if let Some(confirmation) = self.confirmation.take().filter(|_| value == "confirm")
                {
                    let id = self.request(
                        &confirmation.label,
                        confirmation.effect,
                        confirmation.request,
                    );
                    if let Some(form) = confirmation.form {
                        self.form_retries.insert(id, form);
                    }
                }
            }
            Purpose::Attachments => {
                self.panel_target = value.into();
                self.ui.picker = Some(Picker::new(
                    Purpose::AttachmentActions,
                    "Attachment",
                    vec![
                        Item::new("preview", "Preview", ""),
                        Item::new("open", "Open in default application", ""),
                        Item::new("remove", "Remove attachment", "The original file is kept"),
                    ],
                    None,
                ));
            }
            Purpose::AttachmentActions => self.attachment_action(value)?,
            Purpose::Processes => {
                if let Some(process) = value
                    .parse::<u64>()
                    .ok()
                    .and_then(|id| self.processes.items.get(&id))
                {
                    let (title, output) = (process.title.clone(), process.output.clone());
                    self.show_detail(&title, &output);
                    self.ui.reader.as_mut().unwrap().process = value.parse().ok();
                }
            }
            Purpose::Drafts => {
                if let Some(draft) = self.drafts.remove(value) {
                    if !editor.is_empty() || !self.files.is_empty() {
                        self.drafts.insert(
                            format!(
                                "saved:{}",
                                time::OffsetDateTime::now_utc().unix_timestamp_nanos()
                            ),
                            super::drafts::Draft {
                                text: editor.buffer().into(),
                                cursor: editor.cursor(),
                                files: self.files.clone(),
                                scroll: self.ui.scroll,
                                folded: editor.folded,
                                ..Default::default()
                            },
                        );
                    }
                    editor.set_buffer(&draft.text);
                    editor.set_cursor(draft.cursor);
                    editor.folded = draft.folded;
                    self.files = draft.files;
                }
            }
            Purpose::Settings => match value {
                "theme" => self.panel(Purpose::Themes),
                "animations" => {
                    self.preferences.animations = !self.preferences.animations;
                    self.save_preferences()?;
                    self.panel(Purpose::Settings);
                }
                "vim" => {
                    super::commands::run(self, editor, client, "/vim").await?;
                }
                _ => {}
            },
            Purpose::Themes => {
                self.preferences.theme = value.into();
                self.save_preferences()?;
            }
            Purpose::SessionActions => self.session_action(value)?,
            Purpose::Diff => {
                if let Some(file) = self
                    .catalogs
                    .get(&Purpose::Diff)
                    .and_then(|value| value["files"].as_array())
                    .and_then(|files| {
                        files
                            .iter()
                            .find(|file| file["path"].as_str() == Some(value))
                    })
                {
                    let diff = super::render::diff(&json!({"files":[file]}), self.style);
                    self.show_detail(value, &diff);
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn session_actions(&mut self, id: &str) {
        self.panel_target = id.into();
        self.ui.picker = Some(Picker::new(
            Purpose::SessionActions,
            "Session actions",
            vec![
                Item::new("rename", "Rename", ""),
                Item::new("pin", "Pin / unpin", ""),
                Item::new("archive", "Archive", "Keep the conversation in history"),
                Item::new("delete", "Delete", "Requires confirmation"),
            ],
            None,
        ));
    }

    fn session_action(&mut self, action: &str) -> Result<()> {
        let id = self.panel_target.clone();
        let session = self
            .catalogs
            .get(&Purpose::Sessions)
            .and_then(|v| v["sessions"].as_array())
            .and_then(|items| items.iter().find(|item| item["id"] == id))
            .cloned()
            .unwrap_or(Value::Null);
        match action {
            "rename" => self.form(
                "Rename session",
                session["title"].as_str().unwrap_or(""),
                FormAction::Rename(id),
            ),
            "pin" => {
                self.rpc(
                    "Updating pin",
                    Effect::Notice("Session pin updated".into()),
                    "session.setPinned",
                    json!({"sessionId":id,"pinned":session["pinned"] != true}),
                );
            }
            "archive" | "delete" => self.confirm(
                &format!("{action} session {id}?"),
                Effect::SessionRemoved(id.clone()),
                Request::Rpc {
                    method: if action == "archive" {
                        "session.setArchived"
                    } else {
                        "session.delete"
                    }
                    .into(),
                    params: if action == "archive" {
                        json!({"sessionId":id,"archived":true})
                    } else {
                        json!({"sessionId":id})
                    },
                },
            ),
            _ => {}
        }
        Ok(())
    }
}

pub(super) fn resource_id(purpose: Purpose, item: &Value) -> Option<String> {
    if purpose == Purpose::Mcp {
        Some(json!([item["source"], item["pluginId"], item["name"]]).to_string())
    } else {
        item["id"]
            .as_str()
            .or(item["name"].as_str())
            .map(Into::into)
    }
}
