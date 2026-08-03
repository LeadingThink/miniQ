//! End-to-end tests for the tool + approval loop, driven by a scripted mock
//! provider over a real WebSocket connection.

#[path = "tool_approval_integration/approval_decisions.rs"]
mod approval_decisions;
#[path = "tool_approval_integration/approval_modes.rs"]
mod approval_modes;
#[path = "tool_approval_integration/network_approval.rs"]
mod network_approval;
#[path = "tool_approval_integration/support.rs"]
mod support;
#[path = "tool_approval_integration/tool_execution.rs"]
mod tool_execution;
