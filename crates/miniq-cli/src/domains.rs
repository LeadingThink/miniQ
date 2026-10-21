//! Domain routing keeps command syntax independent of RPC method spelling.
mod code;
mod extensions;
mod input;
mod management;
mod models;
#[cfg(test)]
mod tests;

use crate::client::Client;
use crate::domain_args::{DomainCommand, PluginCommand, SkillCommand};
use anyhow::Result;
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub struct DomainRequest {
    pub method: &'static str,
    pub params: Value,
}

impl DomainRequest {
    fn new(method: &'static str, params: Value) -> Self {
        Self { method, params }
    }
}

pub async fn run(client: &mut Client, command: DomainCommand) -> Result<Value> {
    call(client, request(command)?).await
}

pub async fn skills(client: &mut Client, command: SkillCommand) -> Result<Option<Value>> {
    let table = matches!(&command, SkillCommand::List { json: false, .. });
    let result = call(client, skill_request(command)?).await?;
    Ok(extensions::list_output(result, table, true))
}

pub async fn plugins(client: &mut Client, command: PluginCommand) -> Result<Option<Value>> {
    let table = matches!(&command, PluginCommand::List { json: false });
    let result = call(client, plugin_request(command)?).await?;
    Ok(extensions::list_output(result, table, false))
}

async fn call(client: &mut Client, request: DomainRequest) -> Result<Value> {
    // Return the complete result, including every page/chunk continuation token.
    client.call(request.method, request.params).await
}

pub fn request(command: DomainCommand) -> Result<DomainRequest> {
    use DomainCommand::*;
    match command {
        Git { command } => code::git(command),
        Terminal { command } => code::terminal(command),
        File { command } => code::file(command),
        Tool { command } => code::tool(command),
        Voice { command } => code::voice(command),
        Computer { command } => code::computer(command),
        Approval { command } => management::approval(command),
        Review { command } => management::review(command),
        Schedule { command } => management::schedule(command),
        Memory { command } => management::memory(command),
        External { command } => management::external(command),
        Workspace { command } => management::workspace(command),
        Host { command } => management::host(command),
    }
}

pub fn skill_request(command: SkillCommand) -> Result<DomainRequest> {
    extensions::skill(command)
}

pub fn plugin_request(command: PluginCommand) -> Result<DomainRequest> {
    extensions::plugin(command)
}
