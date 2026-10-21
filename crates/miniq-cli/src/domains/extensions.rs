use super::{input, models, DomainRequest};
use crate::domain_args::{PluginCommand, SkillCommand, SkillJobCommand};
use anyhow::Result;
use miniq_protocol::{PluginIdParams, PluginInstallParams, PluginSetEnabledParams};
use serde_json::json;
use serde_json::Value;
use std::io::{self, IsTerminal};

pub(super) fn list_output(result: Value, table: bool, skills: bool) -> Option<Value> {
    if !table || !io::stdout().is_terminal() {
        return Some(result);
    }
    let (key, fields, headers) = if skills {
        (
            "skills",
            ["name", "version", "source", "enabled", "description"],
            ["NAME", "VERSION", "SOURCE", "ENABLED", "DESCRIPTION"],
        )
    } else {
        (
            "plugins",
            ["id", "version", "status", "enabled", "description"],
            ["ID", "VERSION", "STATUS", "ENABLED", "DESCRIPTION"],
        )
    };
    let rows = result[key]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| {
            fields
                .iter()
                .map(|field| {
                    let raw = match &entry[*field] {
                        Value::Null => "-".to_string(),
                        Value::String(value) => value.clone(),
                        value => value.to_string(),
                    };
                    crate::output::terminal_text(&raw).replace(['\n', '\t'], " ")
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        println!("No {key} installed.");
    } else {
        println!("{}", crate::subcommands::table(&headers, &rows));
    }
    None
}

pub(super) fn skill(command: SkillCommand) -> Result<DomainRequest> {
    use SkillCommand::*;
    match command {
        List { workspace, .. } => Ok(DomainRequest::new(
            "skill.list",
            json!({"workspaceId":workspace}),
        )),
        Read { name, workspace } => Ok(DomainRequest::new(
            "skill.read",
            json!({"name":name,"workspaceId":workspace}),
        )),
        Enable { name } => Ok(DomainRequest::new(
            "skill.setEnabled",
            json!({"name":name,"enabled":true}),
        )),
        Disable { name } => Ok(DomainRequest::new(
            "skill.setEnabled",
            json!({"name":name,"enabled":false}),
        )),
        Delete { name, workspace } => Ok(DomainRequest::new(
            "skill.delete",
            json!({"name":name,"workspaceId":workspace}),
        )),
        Import { path } => Ok(DomainRequest::new("skill.import", json!({"path":path}))),
        Create(input) => input::parsed::<models::SkillCreate>("skill.create", &input.input),
        Save(input) => input::parsed::<models::SkillSave>("skill.save", &input.input),
        Validate(input) => input::parsed::<models::SkillContent>("skill.validate", &input.input),
        Distill(input) => input::parsed::<models::SkillDistill>("skill.distill", &input.input),
        Refine(input) => input::parsed::<models::SkillRefine>("skill.refine", &input.input),
        Job { command } => skill_job(command),
    }
}

fn skill_job(command: SkillJobCommand) -> Result<DomainRequest> {
    use SkillJobCommand::*;
    match command {
        Start(input) => input::parsed::<models::SkillJob>("skill.job.start", &input.input),
        List { session } => Ok(DomainRequest::new(
            "skill.job.list",
            json!({"sessionId":session}),
        )),
        Get { job, session } => Ok(DomainRequest::new(
            "skill.job.get",
            json!({"jobId":job,"sessionId":session}),
        )),
        Cancel { job, session } => Ok(DomainRequest::new(
            "skill.job.cancel",
            json!({"jobId":job,"sessionId":session}),
        )),
    }
}

pub(super) fn plugin(command: PluginCommand) -> Result<DomainRequest> {
    use PluginCommand::*;
    match command {
        List { .. } => Ok(DomainRequest::new("plugin.list", json!({}))),
        Install { path, update } => input::checked::<PluginInstallParams>(
            "plugin.install",
            json!({"path":path,"update":update}),
        ),
        Uninstall { id } => input::checked::<PluginIdParams>("plugin.uninstall", json!({"id":id})),
        Reload { id } => input::checked::<PluginIdParams>("plugin.reload", json!({"id":id})),
        Enable { id, trust_code } => input::checked::<PluginSetEnabledParams>(
            "plugin.setEnabled",
            json!({"id":id,"enabled":true,"confirmTrustedCode":trust_code}),
        ),
        Disable { id } => input::checked::<PluginSetEnabledParams>(
            "plugin.setEnabled",
            json!({"id":id,"enabled":false}),
        ),
        Diagnostics { id } => {
            input::checked::<PluginIdParams>("plugin.getDiagnostics", json!({"id":id}))
        }
    }
}
