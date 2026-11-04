//! Resource actions share the daemon's existing mutation contracts.
use super::{
    forms::FormAction,
    jobs::Effect,
    picker::{Item, Picker, Purpose},
    requests::Request,
    Repl,
};
use anyhow::{Context, Result};
use serde_json::json;
use std::path::PathBuf;

impl Repl {
    pub(super) fn message_action(&mut self, action: &str) -> Result<()> {
        let message = self
            .message(&self.panel_target)
            .context("message is no longer loaded")?;
        let id = self.panel_target.clone();
        let content = message["content"].as_str().unwrap_or("").to_owned();
        match action {
            "jump" => {
                if self
                    .ui
                    .transcript
                    .entries
                    .iter()
                    .any(|entry| entry.id == id)
                {
                    self.ui.jump_to(&id);
                } else {
                    self.request(
                        "Locating message",
                        Effect::Locate(id.clone()),
                        Request::Locate(id),
                    );
                }
            }
            "copy" => {
                self.copy_selection(&content);
            }
            "edit" => self.form(
                "Edit message and rerun",
                message["content"].as_str().unwrap_or(&content),
                FormAction::Rewrite(message.clone()),
            ),
            "undo" => self.confirm(
                "Undo this prompt and later replies, restoring edited files?",
                Effect::Undo,
                Request::Rpc {
                    method: "session.undo".into(),
                    params: json!({"sessionId":self.session,"messageId":id}),
                },
            ),
            "fork" => {
                self.switch_request = Some(self.request(
                    "Forking from reply",
                    Effect::Switch,
                    Request::Fork {
                        anchor: Some(id),
                        title: String::new(),
                    },
                ));
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn resource_actions(&mut self, purpose: Purpose) {
        let (next, actions): (_, &[(&str, &str)]) = match purpose {
            Purpose::Queue => (
                Purpose::QueueActions,
                &[
                    ("edit", "Edit message"),
                    ("up", "Move earlier"),
                    ("down", "Move later"),
                    ("steer", "Steer current turn"),
                    ("remove", "Remove from queue"),
                ],
            ),
            Purpose::Agents => (
                Purpose::AgentActions,
                &[
                    ("output", "Latest output"),
                    ("history", "History"),
                    ("stop", "Stop agent"),
                ],
            ),
            Purpose::Mcp => (
                Purpose::McpActions,
                &[
                    ("details", "Details"),
                    ("toggle", "Enable / disable"),
                    ("edit", "Edit server settings"),
                    ("connect", "Connect and inspect tools"),
                ],
            ),
            Purpose::Skills => (
                Purpose::SkillActions,
                &[("read", "Read skill"), ("toggle", "Enable / disable")],
            ),
            _ => return,
        };
        let title = if purpose == Purpose::Mcp {
            "MCP server actions"
        } else {
            &self.panel_target
        };
        self.ui.picker = Some(Picker::new(
            next,
            title,
            actions
                .iter()
                .map(|(id, title)| Item::new(id, title, ""))
                .collect(),
            None,
        ));
    }

    pub(super) fn resource_action(&mut self, purpose: Purpose, action: &str) -> Result<()> {
        let (source, key) = match purpose {
            Purpose::QueueActions => (Purpose::Queue, "queue"),
            Purpose::AgentActions => (Purpose::Agents, "agents"),
            Purpose::McpActions => (Purpose::Mcp, "servers"),
            Purpose::SkillActions => (Purpose::Skills, "skills"),
            _ => return Ok(()),
        };
        let catalog = self
            .catalogs
            .get(&source)
            .context("Refresh the list first")?
            .clone();
        let item = catalog[key]
            .as_array()
            .or(catalog.as_array())
            .into_iter()
            .flatten()
            .find(|item| {
                super::panels::resource_id(source, item).as_deref() == Some(&self.panel_target)
            })
            .context("item no longer exists; refresh the list")?
            .clone();
        let id = self.panel_target.clone();
        match source {
            Purpose::Queue => match action {
                "edit" => self.form(
                    "Edit queued message",
                    item["content"].as_str().unwrap_or(""),
                    FormAction::QueueEdit(item.clone()),
                ),
                "up" | "down" => {
                    self.rpc("Moving queued message", Effect::Notice("Queue order updated".into()), "session.queueMove",
                    json!({"sessionId":self.session,"queuedMessageId":id,"expectedPosition":item["position"],"direction":action}));
                }
                "remove" | "steer" => self.confirm(
                    if action == "remove" {
                        "Remove this queued message?"
                    } else {
                        "Interrupt and steer the current turn with this message?"
                    },
                    Effect::Notice("Queue updated".into()),
                    Request::Rpc {
                        method: if action == "remove" {
                            "session.queueRemove"
                        } else {
                            "session.queueSteer"
                        }
                        .into(),
                        params: json!({"queuedMessageId":id}),
                    },
                ),
                _ => {}
            },
            Purpose::Agents => {
                let params = json!({"sessionId":self.session,"agentId":id});
                if action == "stop" {
                    self.confirm(
                        "Stop this agent?",
                        Effect::Notice("Agent stop requested".into()),
                        Request::Rpc {
                            method: "agent.stop".into(),
                            params,
                        },
                    );
                } else if action == "history" {
                    self.agent_history(&id, None);
                } else {
                    self.remote_detail(&format!("Agent {id}"), "agent.output", params, true);
                }
            }
            Purpose::Mcp => match action {
                "details" => self.show_detail(
                    item["name"].as_str().unwrap_or("MCP server"),
                    &serde_json::to_string_pretty(&item)?,
                ),
                "connect" => {
                    self.rpc(
                        "Connecting MCP servers",
                        Effect::Detail("MCP tools".into()),
                        "mcp.list",
                        json!({"connect":true}),
                    );
                }
                "toggle" | "edit" => {
                    anyhow::ensure!(
                        item["readOnly"] != true && item["source"] != "plugin",
                        "Plugin-owned servers are managed by their plugin"
                    );
                    let mut servers: Vec<_> = catalog["servers"]
                        .as_array()
                        .context("invalid MCP list")?
                        .iter()
                        .filter(|server| server["source"] != "plugin")
                        .cloned()
                        .collect();
                    if action == "toggle" {
                        for server in &mut servers {
                            if server["name"] == item["name"] {
                                server["enabled"] = json!(server["enabled"] != true);
                            }
                        }
                        self.rpc(
                            "Updating MCP server",
                            Effect::Notice("MCP server updated".into()),
                            "mcp.update",
                            json!({"servers":servers}),
                        );
                    } else {
                        let value = json!({"servers":servers});
                        self.form(
                            "Edit MCP settings (JSON)",
                            &serde_json::to_string_pretty(&value)?,
                            FormAction::Mcp,
                        );
                    }
                }
                _ => {}
            },
            Purpose::Skills => {
                let params = json!({"name":id,"workspaceId":self.workspace,"enabled":item["enabled"] != true});
                self.rpc(
                    "Loading skill",
                    if action == "read" {
                        Effect::Detail(id)
                    } else {
                        Effect::Notice("Skill updated".into())
                    },
                    if action == "read" {
                        "skill.read"
                    } else {
                        "skill.setEnabled"
                    },
                    params,
                );
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn attachment_action(&mut self, action: &str) -> Result<()> {
        let index = self.panel_target.parse::<usize>()?;
        let path = self
            .files
            .get(index)
            .context("attachment no longer exists")?
            .clone();
        match action {
            "remove" => {
                self.files.remove(index);
            }
            "open" => super::platform::open(&path)?,
            "preview" => self.preview_attachment(path),
            _ => {}
        }
        Ok(())
    }

    pub(super) fn export_session(&mut self, path: PathBuf) -> Result<u64> {
        Ok(self.request(
            "Exporting conversation",
            Effect::Notice(format!("Exported to {}", path.display())),
            Request::Export(path),
        ))
    }
}
