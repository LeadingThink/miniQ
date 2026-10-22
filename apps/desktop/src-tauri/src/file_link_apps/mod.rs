//! Real OS-registered handlers for an authorized local file.

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[path = "unsupported.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod platform;

pub use platform::{applications, open};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOpenApplication {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

fn selected_application<'a>(
    applications: &'a [FileOpenApplication],
    id: &str,
) -> Result<&'a FileOpenApplication, String> {
    applications
        .iter()
        .find(|application| application.id == id)
        .ok_or_else(|| "所选应用不在此文件当前可用的打开方式中，请重新选择".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_an_id_from_the_current_file_handlers() {
        let applications = vec![FileOpenApplication {
            id: "registered-handler".into(),
            name: "Registered application".into(),
            is_default: true,
        }];
        assert!(selected_application(&applications, "registered-handler").is_ok());
        assert!(selected_application(&applications, "arbitrary-program --flag").is_err());
        assert!(selected_application(&[], "registered-handler").is_err());
    }

    #[test]
    fn serializes_the_frontend_contract() {
        let application = FileOpenApplication {
            id: "handler".into(),
            name: "Application".into(),
            is_default: true,
        };
        assert_eq!(
            serde_json::to_value(application).unwrap(),
            serde_json::json!({ "id": "handler", "name": "Application", "isDefault": true })
        );
    }
}
