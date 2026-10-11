//! Per-method remote access policy (plan v3 §13.1, M0b).
//!
//! Every JSON-RPC method reachable from a remote origin (the encrypted relay or
//! a forwarded `host.call`) must be declared here. Undeclared methods are denied
//! by default, so adding a gateway method without grading it cannot silently
//! expose it to a phone. A unit test cross-checks the gateway dispatch table.

use miniq_protocol::{ErrorCode, RpcError};
use serde_json::{json, Value};

/// Remote grading of a method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteLevel {
    /// Pure reads.
    ReadOnly,
    /// Mutations that remote users may perform.
    Allow,
    /// Enable/disable switches.
    ToggleOnly,
    /// Allowed only after inspecting params (see [`check`]).
    Policy,
    /// Desktop-only; remote callers receive `REMOTE_FORBIDDEN`.
    HostOnly,
}

/// Prefix used for request origins coming from remote devices.
pub const REMOTE_ORIGIN_PREFIX: &str = "remote";

pub fn is_remote_origin(origin: Option<&str>) -> bool {
    origin.is_some_and(|origin| origin == REMOTE_ORIGIN_PREFIX || origin.starts_with("remote:"))
}

/// Returns the declared remote level, or `None` when the method is undeclared.
pub fn level(method: &str) -> Option<RemoteLevel> {
    use RemoteLevel::*;
    Some(match method {
        // 13.1.2 session / approval / schedule
        "session.list"
        | "review.list"
        | "review.get"
        | "session.open"
        | "session.sync"
        | "session.history"
        | "session.search"
        | "session.modelCalls"
        | "session.contextUsage"
        | "session.executionEvents"
        | "session.diff"
        | "session.modelGet"
        | "session.goal.get"
        | "session.queueList"
        | "session.approval.get"
        | "session.shareList"
        | "approval.inbox"
        | "schedule.list"
        | "schedule.runs" => ReadOnly,
        "session.approval.update"
        | "review.cancel"
        | "approval.resolve"
        | "schedule.create"
        | "schedule.update"
        | "host.call" => Policy,
        "session.create"
        | "review.start"
        | "session.fork"
        | "session.sendMessage"
        | "session.rewriteMessage"
        | "session.undo"
        | "session.revertTurn"
        | "session.compact"
        | "session.pause"
        | "session.resume"
        | "session.cancel"
        | "session.queueUpdate"
        | "session.queueMove"
        | "session.queueRemove"
        | "session.queueSteer"
        | "session.rename"
        | "session.setPinned"
        | "session.setArchived"
        | "session.goal.update"
        | "session.acknowledgeFailure"
        | "session.modelUpdate"
        | "session.delete"
        | "session.shareCreate"
        | "session.shareRevoke"
        | "question.resolve"
        | "schedule.delete"
        | "schedule.runNow" => Allow,
        "schedule.toggle" => ToggleOnly,
        // 13.1.1 plugins / MCP / connectors / approvals
        "plugin.list"
        | "plugin.getDiagnostics"
        | "mcp.list"
        | "approval.rules.list"
        | "features.get"
        | "hooks.list"
        | "settings.status" => ReadOnly,
        "approval.rules.revoke" => Allow,
        "plugin.setEnabled" => ToggleOnly,
        "plugin.install"
        | "plugin.installLocal"
        | "plugin.reload"
        | "plugin.uninstall"
        | "mcp.update"
        | "automation.grant"
        | "connector.confirmReadonlySet"
        | "features.set"
        | "settings.restoreBackup" => HostOnly,
        // 13.1.3 existing blacklist
        "browser.resolve"
        | "daemon.shutdown"
        | "daemon.shutdownIfIdle"
        | "computer.requestPermission"
        | "settings.update"
        | "workspace.open"
        | "workspace.updateRoots"
        | "externalSession.import"
        | "skill.delete"
        | "host.save"
        | "host.remove" => HostOnly,
        "daemon.health"
        | "host.list"
        | "file.describe"
        | "file.read"
        | "file.list"
        | "computer.permissions"
        | "workspace.list"
        | "memory.list"
        | "tool.detail"
        | "tool.list"
        | "model.list"
        | "model.describe"
        | "workspace.modelGet"
        | "agent.list"
        | "agent.output"
        | "agent.history"
        | "externalSession.scan"
        | "externalSession.scanStatus"
        | "externalSession.importStatus"
        | "observation.read"
        | "settings.get"
        | "settings.models"
        | "settings.schema"
        | "remote.status"
        | "voice.capabilities"
        | "skill.list"
        | "skill.read" => ReadOnly,
        "host.connect"
        | "host.disconnect"
        | "workspace.create"
        | "workspace.rename"
        | "workspace.delete"
        | "memory.delete"
        | "model.update"
        | "workspace.modelUpdate"
        | "agent.message"
        | "agent.stop"
        | "checkpoint.rollback"
        | "voice.transcribe"
        | "voice.speak"
        | "skill.import"
        | "skill.distill"
        | "skill.refine"
        | "skill.save" => Allow,
        "skill.setEnabled" => ToggleOnly,
        _ => return None,
    })
}

/// Whether a successful remote call of this method must be written to the audit log.
pub fn audited(method: &str) -> bool {
    matches!(
        method,
        "session.approval.update"
            | "session.delete"
            | "session.shareCreate"
            | "session.shareRevoke"
            | "approval.resolve"
            | "approval.rules.revoke"
            | "schedule.create"
            | "schedule.update"
            | "schedule.toggle"
            | "schedule.delete"
            | "schedule.runNow"
            | "plugin.setEnabled"
            | "workspace.delete"
            | "memory.delete"
    )
}

/// Builds the `REMOTE_FORBIDDEN` error (Unauthorized, §13.2).
pub fn forbidden(method: &str, reason: &str, message: impl Into<String>) -> RpcError {
    let mut error = RpcError::new(ErrorCode::Unauthorized, message);
    error.data = Some(json!({
        "code": "REMOTE_FORBIDDEN",
        "reason": reason,
        "host_command": method,
    }));
    error
}

const SCHEDULE_GRANT_KEYS: &[&str] = &[
    "grant",
    "grants",
    "preapprovedTools",
    "preapproved_tools",
    "approvalMode",
    "approval_mode",
];

/// Checks a remote request against the registry, including params-level policy.
pub fn check(method: &str, params: Option<&Value>) -> Result<(), RpcError> {
    check_depth(method, params, 0)
}

fn check_depth(method: &str, params: Option<&Value>, depth: usize) -> Result<(), RpcError> {
    match level(method) {
        None => Err(forbidden(
            method,
            "undeclared",
            "该操作未开放远程访问，请在桌面端执行",
        )),
        Some(RemoteLevel::HostOnly) => {
            Err(forbidden(method, "host_only", "该管理操作只能在桌面端执行"))
        }
        Some(RemoteLevel::ReadOnly | RemoteLevel::Allow | RemoteLevel::ToggleOnly) => Ok(()),
        Some(RemoteLevel::Policy) => policy(method, params, depth),
    }
}

fn policy(method: &str, params: Option<&Value>, depth: usize) -> Result<(), RpcError> {
    match method {
        // D16: remote may raise or lower the per-session mode; the handler
        // validates `mode`, audits and notifies the host.
        "session.approval.update" => Ok(()),
        "approval.resolve" => {
            let decision = params.and_then(|p| p["decision"].as_str()).unwrap_or("");
            if matches!(decision, "always_allow_tool" | "alwaysAllowTool") {
                return Err(forbidden(
                    method,
                    "always_allow_tool",
                    "“总是允许”只能在桌面端设置；远程可选择本次允许或本会话允许",
                ));
            }
            Ok(())
        }
        "schedule.create" | "schedule.update" => {
            if let Some(Value::Object(map)) = params {
                if SCHEDULE_GRANT_KEYS.iter().any(|key| map.contains_key(*key)) {
                    return Err(forbidden(
                        method,
                        "schedule_grant",
                        "定时任务授权只能在桌面端通过 automation.grant 设置",
                    ));
                }
            }
            Ok(())
        }
        "host.call" => {
            if depth > 0 {
                return Err(forbidden(method, "nested_host_call", "不允许嵌套转发"));
            }
            let inner = params.and_then(|p| p["method"].as_str()).unwrap_or("");
            if inner.is_empty() || inner.starts_with("host.") {
                return Err(forbidden(
                    inner,
                    "host_only",
                    "远程不能通过 host.call 转发主机管理操作",
                ));
            }
            check_depth(inner, params.and_then(|p| p.get("params")), depth + 1)
        }
        _ => Err(forbidden(method, "undeclared", "该操作未开放远程访问")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(result: Result<(), RpcError>) -> String {
        let error = result.unwrap_err();
        assert_eq!(error.code, ErrorCode::Unauthorized as i64);
        let data = error.data.unwrap();
        assert_eq!(data["code"], "REMOTE_FORBIDDEN");
        data["reason"].as_str().unwrap().to_string()
    }

    /// CI missing-declaration check: every gateway method must be graded.
    #[test]
    fn every_gateway_method_is_declared() {
        let source = include_str!("gateway.rs");
        let mut missing = Vec::new();
        for piece in source.split('"').skip(1).step_by(2) {
            let looks_like_method = piece.contains('.')
                && !piece.contains(' ')
                && piece.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && piece.chars().all(|c| c.is_ascii_alphanumeric() || c == '.');
            if looks_like_method && level(piece).is_none() {
                missing.push(piece.to_string());
            }
        }
        assert!(missing.is_empty(), "undeclared remote methods: {missing:?}");
    }

    #[test]
    fn undeclared_methods_are_denied_by_default() {
        assert_eq!(reason(check("plugin.brandNew", None)), "undeclared");
    }

    #[test]
    fn legacy_blacklist_stays_host_only() {
        for method in [
            "browser.resolve",
            "daemon.shutdown",
            "daemon.shutdownIfIdle",
            "computer.requestPermission",
            "settings.update",
            "workspace.open",
            "workspace.updateRoots",
            "externalSession.import",
            "mcp.update",
            "skill.delete",
            "host.save",
            "host.remove",
        ] {
            assert_eq!(reason(check(method, None)), "host_only", "{method}");
        }
        assert!(check("session.sendMessage", None).is_ok());
        assert!(check("computer.permissions", None).is_ok());
    }

    #[test]
    fn rt01_remote_can_raise_session_mode_but_not_always_allow() {
        let raise = json!({"sessionId":"s","mode":"fullAccess"});
        assert!(check("session.approval.update", Some(&raise)).is_ok());
        for decision in ["approve", "approve_for_session", "reject"] {
            let params = json!({"approvalId":"a","decision":decision});
            assert!(check("approval.resolve", Some(&params)).is_ok());
        }
        let always = json!({"approvalId":"a","decision":"always_allow_tool"});
        assert_eq!(
            reason(check("approval.resolve", Some(&always))),
            "always_allow_tool"
        );
    }

    #[test]
    fn privileged_plugin_and_grant_methods_are_host_only() {
        for method in [
            "plugin.install",
            "plugin.installLocal",
            "plugin.reload",
            "plugin.uninstall",
            "automation.grant",
            "connector.confirmReadonlySet",
        ] {
            assert_eq!(reason(check(method, None)), "host_only", "{method}");
        }
    }

    #[test]
    fn schedules_cannot_carry_grants_remotely() {
        let plain = json!({"workspaceId":"w","name":"n","prompt":"p","schedule":{}});
        assert!(check("schedule.create", Some(&plain)).is_ok());
        let granted = json!({"workspaceId":"w","grant":["shell_run"]});
        assert_eq!(
            reason(check("schedule.update", Some(&granted))),
            "schedule_grant"
        );
    }

    #[test]
    fn host_call_checks_the_inner_method_with_params() {
        let ok = json!({"hostId":"h","method":"session.list"});
        assert!(check("host.call", Some(&ok)).is_ok());
        let host = json!({"hostId":"h","method":"host.save"});
        assert_eq!(reason(check("host.call", Some(&host))), "host_only");
        let blocked = json!({"hostId":"h","method":"settings.update"});
        assert_eq!(reason(check("host.call", Some(&blocked))), "host_only");
        let always = json!({"hostId":"h","method":"approval.resolve",
            "params":{"approvalId":"a","decision":"always_allow_tool"}});
        assert_eq!(
            reason(check("host.call", Some(&always))),
            "always_allow_tool"
        );
        let unknown = json!({"hostId":"h","method":"new.request"});
        assert_eq!(reason(check("host.call", Some(&unknown))), "undeclared");
    }

    #[test]
    fn origin_detection() {
        assert!(is_remote_origin(Some("remote")));
        assert!(is_remote_origin(Some("remote:phone")));
        assert!(!is_remote_origin(Some("remotely")));
        assert!(!is_remote_origin(None));
    }
}
