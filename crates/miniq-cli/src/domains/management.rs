use super::{input, models, DomainRequest};
use crate::domain_args::*;
use anyhow::Result;
use miniq_protocol::*;
use serde_json::json;

pub(super) fn approval(command: ApprovalCommand) -> Result<DomainRequest> {
    use ApprovalCommand::*;
    match command {
        Inbox { before } => input::checked::<ApprovalInboxParams>(
            "approval.inbox",
            json!({"before":input::cursor(before)?}),
        ),
        Rules => Ok(DomainRequest::new("approval.rules.list", json!({}))),
        Revoke { rule } => Ok(DomainRequest::new(
            "approval.rules.revoke",
            json!({"ruleId":rule}),
        )),
        Resolve {
            approval_id,
            decision,
        } => Ok(DomainRequest::new(
            "approval.resolve",
            json!({"approvalId":approval_id,"decision":decision}),
        )),
    }
}

pub(super) fn review(command: ReviewCommand) -> Result<DomainRequest> {
    use ReviewCommand::*;
    match command {
        Start {
            session,
            message,
            reviewer_model,
        } => input::checked::<ReviewStartParams>(
            "review.start",
            json!({"sessionId":session,"primaryMessageId":message,"model":reviewer_model}),
        ),
        List {
            session,
            message,
            cursor,
            limit,
        } => input::checked::<ReviewListParams>(
            "review.list",
            json!({"sessionId":session,"primaryMessageId":message,"cursor":cursor,"limit":limit}),
        ),
        Get { session, review } => input::checked::<ReviewIdParams>(
            "review.get",
            json!({"sessionId":session,"reviewId":review}),
        ),
        Cancel { session, review } => input::checked::<ReviewIdParams>(
            "review.cancel",
            json!({"sessionId":session,"reviewId":review}),
        ),
    }
}

pub(super) fn schedule(command: ScheduleCommand) -> Result<DomainRequest> {
    use ScheduleCommand::*;
    match command {
        List => Ok(DomainRequest::new("schedule.list", json!({}))),
        Runs {
            task,
            cursor,
            limit,
        } => Ok(DomainRequest::new(
            "schedule.runs",
            json!({"taskId":task,"cursor":cursor,"limit":limit}),
        )),
        Create(input) => input::parsed::<models::ScheduleCreate>("schedule.create", &input.input),
        Update(input) => input::parsed::<models::ScheduleUpdate>("schedule.update", &input.input),
        Delete { task } => Ok(DomainRequest::new("schedule.delete", json!({"id":task}))),
        Enable { task } => Ok(DomainRequest::new(
            "schedule.toggle",
            json!({"id":task,"enabled":true}),
        )),
        Disable { task } => Ok(DomainRequest::new(
            "schedule.toggle",
            json!({"id":task,"enabled":false}),
        )),
        Run { task } => Ok(DomainRequest::new("schedule.runNow", json!({"id":task}))),
    }
}

pub(super) fn memory(command: MemoryCommand) -> Result<DomainRequest> {
    match command {
        MemoryCommand::List(input) => {
            input::parsed::<MemoryListParams>("memory.list", &input.input)
        }
        MemoryCommand::Delete(input) => {
            input::parsed::<MemoryDeleteParams>("memory.delete", &input.input)
        }
    }
}

pub(super) fn external(command: ExternalCommand) -> Result<DomainRequest> {
    use ExternalCommand::*;
    match command {
        Scan => Ok(DomainRequest::new("externalSession.scan", json!({}))),
        ScanStatus { job } => input::checked::<ExternalSessionScanStatusRequest>(
            "externalSession.scanStatus",
            json!({"jobId":job}),
        ),
        Import(input) => {
            input::parsed::<ExternalSessionImportRequest>("externalSession.import", &input.input)
        }
        ImportStatus { job } => input::checked::<ExternalSessionImportStatusRequest>(
            "externalSession.importStatus",
            json!({"jobId":job}),
        ),
    }
}

pub(super) fn workspace(command: WorkspaceCommand) -> Result<DomainRequest> {
    use WorkspaceCommand::*;
    match command {
        List => Ok(DomainRequest::new("workspace.list", json!({}))),
        Open { path, name } => Ok(DomainRequest::new(
            "workspace.open",
            json!({"path":path,"name":name}),
        )),
        Create { name } => Ok(DomainRequest::new("workspace.create", json!({"name":name}))),
        Rename { workspace, name } => Ok(DomainRequest::new(
            "workspace.rename",
            json!({"workspaceId":workspace,"name":name}),
        )),
        Delete { workspace } => Ok(DomainRequest::new(
            "workspace.delete",
            json!({"workspaceId":workspace}),
        )),
        Roots(input) => {
            input::parsed::<WorkspaceRootsUpdate>("workspace.updateRoots", &input.input)
        }
        ModelGet { workspace } => Ok(DomainRequest::new(
            "workspace.modelGet",
            json!({"workspaceId":workspace}),
        )),
        ModelSet(input) => {
            input::parsed::<WorkspaceModelUpdate>("workspace.modelUpdate", &input.input)
        }
    }
}

pub(super) fn host(command: HostCommand) -> Result<DomainRequest> {
    use HostCommand::*;
    Ok(match command {
        List => DomainRequest::new("host.list", json!({})),
        Save { host } => DomainRequest::new("host.save", json!({"hostId":host})),
        Remove { host } => DomainRequest::new("host.remove", json!({"hostId":host})),
        Connect { host } => DomainRequest::new("host.connect", json!({"hostId":host})),
        Disconnect { host } => DomainRequest::new("host.disconnect", json!({"hostId":host})),
    })
}
