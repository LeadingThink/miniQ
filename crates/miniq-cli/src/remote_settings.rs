//! Shared remote settings for rich and line-mode terminal sessions.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::{
    client::Client,
    monitor::line,
    output::progress,
    selection::{choose, Choice},
};

const USAGE: &str = "用法：/remote [on|off|status|name 设备名称]";

pub async fn run(client: &mut Client, arg: &str) -> Result<()> {
    let settings = client.call("settings.get", json!({})).await?;
    let status = client.call("remote.status", json!({})).await?;
    progress(&summary(&settings, &status));
    let action = if arg.is_empty() {
        let choices = [
            Choice {
                id: "on".into(),
                label: "开启远程连接".into(),
            },
            Choice {
                id: "off".into(),
                label: "关闭远程连接".into(),
            },
            Choice {
                id: "name".into(),
                label: "修改设备名称".into(),
            },
            Choice {
                id: "status".into(),
                label: "刷新连接状态".into(),
            },
        ];
        let Some(action) = choose("远程连接设置（这台电脑共用）", &choices, None)?
        else {
            return Ok(());
        };
        if action == "name" {
            let Some(name) = line("设备名称（留空取消）> ")? else {
                return Ok(());
            };
            if name.trim().is_empty() {
                return Ok(());
            }
            format!("name {}", name.trim())
        } else {
            action
        }
    } else {
        arg.to_owned()
    };
    let Some(update) = update(&settings, &action)? else {
        return Ok(());
    };
    client.call("settings.update", update).await?;
    progress("远程设置已保存。连接状态可能需要几秒更新，使用 /remote status 查看。\n手机使用同一个在问 API Key，并在设备列表中选择这台电脑。保持电脑在线和后台运行。");
    Ok(())
}

fn update(settings: &Value, action: &str) -> Result<Option<Value>> {
    let (command, arg) = action
        .split_once(char::is_whitespace)
        .map_or((action, ""), |(c, a)| (c, a.trim()));
    let (key, value) = match (command, arg) {
        ("on", "") => ("remoteAccess.enabled", "true"),
        ("off", "") => ("remoteAccess.enabled", "false"),
        ("status", "") => return Ok(None),
        ("name", name) if !name.is_empty() && name.chars().count() <= 80 => {
            ("remoteAccess.deviceName", name)
        }
        _ => bail!("{USAGE}；设备名称须为 1–80 个字符"),
    };
    settings["remoteAccess"]
        .as_object()
        .context("后台未返回远程连接配置")?;
    Ok(Some(crate::subcommands::config_update(
        settings, key, value,
    )?))
}

fn summary(settings: &Value, status: &Value) -> String {
    let remote = &settings["remoteAccess"];
    let state = match status["state"].as_str().unwrap_or("unknown") {
        "disabled" => "未连接",
        "waiting_for_key" => "等待 API Key，请先在终端运行 miniq configure",
        "connecting" => "正在连接",
        "reconnecting" => "正在重新连接",
        "connected" => "已连接",
        _ => "未知",
    };
    format!(
        "远程连接：{}\n设备名称：{}\n连接状态：{state}\n已连接手机：{}\n{USAGE}",
        if remote["enabled"] == true {
            "已开启"
        } else {
            "已关闭"
        },
        crate::output::terminal_text(remote["deviceName"].as_str().unwrap_or("未设置")),
        status["mobileClients"].as_u64().unwrap_or(0)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_waiting_for_key_without_printing_credentials() {
        let settings = json!({"provider":{"apiKey":"private-key"},"remoteAccess":{"enabled":true,"deviceName":"我的电脑","deviceId":"private-id"}});
        let text = summary(
            &settings,
            &json!({"state":"waiting_for_key","mobileClients":0}),
        );
        assert!(text.contains("miniq configure"));
        assert!(text.contains("我的电脑"));
        assert!(!text.contains("private"));
    }

    #[test]
    fn edits_remote_settings_without_changing_other_settings_or_identity() {
        let settings = json!({"provider":{"hasApiKey":true},"approvalMode":"alwaysAsk",
            "remoteAccess":{"enabled":false,"relayUrl":"wss://custom.test/ws","deviceName":"旧名称","deviceId":"keep-id"}});
        assert_eq!(
            update(&settings, "on").unwrap().unwrap(),
            json!({"remoteAccess":{"enabled":true,"relayUrl":"wss://custom.test/ws","deviceName":"旧名称"}})
        );
        assert_eq!(
            update(&settings, "off").unwrap().unwrap()["remoteAccess"]["enabled"],
            false
        );
        assert_eq!(
            update(&settings, "name 我的 服务器").unwrap().unwrap()["remoteAccess"]["deviceName"],
            "我的 服务器"
        );
        assert!(update(&settings, "status").unwrap().is_none());
        for invalid in ["name", "on extra", "unknown"] {
            assert!(update(&settings, invalid).is_err());
        }
        assert!(update(&settings, &format!("name {}", "名".repeat(81))).is_err());
    }
}
