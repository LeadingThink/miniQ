use miniq_protocol::{ApprovalMode, RpcError};
use serde_json::{json, Value};

/// Settings navigation groups in display order: `(id, label, lucide icon)`.
const GROUPS: [(&str, &str, &str); 8] = [
    ("general", "通用", "settings"),
    ("appearance", "外观", "palette"),
    ("services", "服务与远程", "server"),
    ("computer", "电脑控制", "monitor"),
    ("skills", "技能", "sparkles"),
    ("mcp", "MCP 连接", "plug"),
    ("plugins", "插件", "puzzle"),
    ("memory", "记忆", "brain"),
];

/// Read-only description of the settings UI: ordered groups and the values a
/// fresh install starts with. Contains no user data.
pub(super) fn schema() -> Result<Value, RpcError> {
    let groups: Vec<Value> = GROUPS
        .iter()
        .map(|(id, label, icon)| json!({ "id": id, "label": label, "icon": icon }))
        .collect();
    Ok(json!({
        "groups": groups,
        "defaults": {
            "approvalMode": ApprovalMode::default(),
            "theme": "system",
            "lightTheme": "jade",
            "darkTheme": "night",
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_lists_groups_in_order_with_defaults() {
        let value = schema().unwrap();
        let ids: Vec<&str> = value["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|group| group["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            [
                "general",
                "appearance",
                "services",
                "computer",
                "skills",
                "mcp",
                "plugins",
                "memory"
            ]
        );
        assert_eq!(value["groups"][5]["label"], "MCP 连接");
        assert_eq!(value["groups"][0]["icon"], "settings");
        assert_eq!(value["defaults"]["approvalMode"], "auto");
        assert_eq!(value["defaults"]["theme"], "system");
    }
}
