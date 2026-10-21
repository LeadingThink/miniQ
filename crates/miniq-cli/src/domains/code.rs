use super::{input, models, DomainRequest};
use crate::domain_args::*;
use anyhow::Result;
use miniq_protocol::{ComputerPermissionRequest, ToolDetailParams};
use serde_json::json;

pub(super) fn git(command: GitCommand) -> Result<DomainRequest> {
    Ok(match command {
        GitCommand::Status { session } => {
            DomainRequest::new("git.status", json!({"sessionId":session}))
        }
        GitCommand::Diff {
            session,
            path,
            staged,
        } => DomainRequest::new(
            "git.diff",
            json!({"sessionId":session,"path":path,"staged":staged}),
        ),
    })
}

pub(super) fn terminal(command: TerminalCommand) -> Result<DomainRequest> {
    use TerminalCommand::*;
    Ok(match command {
        Create {
            session,
            rows,
            cols,
        } => DomainRequest::new(
            "terminal.create",
            json!({"sessionId":session,"rows":rows,"cols":cols}),
        ),
        Read {
            session,
            terminal,
            offset,
            wait_ms,
        } => DomainRequest::new(
            "terminal.read",
            json!({"sessionId":session,"terminalId":terminal,"offset":offset,"waitMs":wait_ms}),
        ),
        Input {
            session,
            terminal,
            data,
        } => DomainRequest::new(
            "terminal.input",
            json!({"sessionId":session,"terminalId":terminal,"data":input::text(&data)?}),
        ),
        Resize {
            session,
            terminal,
            rows,
            cols,
        } => DomainRequest::new(
            "terminal.resize",
            json!({"sessionId":session,"terminalId":terminal,"rows":rows,"cols":cols}),
        ),
        Close { session, terminal } => DomainRequest::new(
            "terminal.close",
            json!({"sessionId":session,"terminalId":terminal}),
        ),
    })
}

pub(super) fn file(command: FileCommand) -> Result<DomainRequest> {
    use FileCommand::*;
    Ok(match command {
        List {
            session,
            path,
            after,
        } => DomainRequest::new(
            "file.list",
            json!({"sessionId":session,"path":path,"after":after}),
        ),
        Describe { session, path } => {
            DomainRequest::new("file.describe", json!({"sessionId":session,"path":path}))
        }
        Read {
            session,
            path,
            revision,
            offset,
        } => DomainRequest::new(
            "file.read",
            json!({"sessionId":session,"path":path,"revision":revision,"offset":offset}),
        ),
    })
}

pub(super) fn tool(command: ToolCommand) -> Result<DomainRequest> {
    match command {
        ToolCommand::List => Ok(DomainRequest::new("tool.list", json!({}))),
        ToolCommand::Detail { session, tool_call } => input::checked::<ToolDetailParams>(
            "tool.detail",
            json!({"sessionId":session,"toolCallId":tool_call}),
        ),
    }
}

pub(super) fn voice(command: VoiceCommand) -> Result<DomainRequest> {
    match command {
        VoiceCommand::Capabilities => Ok(DomainRequest::new("voice.capabilities", json!({}))),
        VoiceCommand::Transcribe(input) => {
            input::parsed::<models::Transcribe>("voice.transcribe", &input.input)
        }
        VoiceCommand::Speak(input) => input::parsed::<models::Speak>("voice.speak", &input.input),
    }
}

pub(super) fn computer(command: ComputerCommand) -> Result<DomainRequest> {
    match command {
        ComputerCommand::Permissions => Ok(DomainRequest::new("computer.permissions", json!({}))),
        ComputerCommand::Request { permission } => input::checked::<ComputerPermissionRequest>(
            "computer.requestPermission",
            json!({"permission":permission}),
        ),
    }
}
