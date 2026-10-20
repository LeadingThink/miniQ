//! Restricts the new mobile grant path; existing desktop/root permissions are unchanged.
use crate::state::AppState;
use std::path::Path;

pub(super) fn check(state: &AppState, path: &Path) -> Result<(), &'static str> {
    let parts: Vec<_> = path
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    let denied = parts.iter().any(|part| {
        matches!(
            part.as_str(),
            ".ssh"
                | ".aws"
                | ".azure"
                | ".gnupg"
                | ".kube"
                | ".docker"
                | ".config"
                | ".miniq"
                | ".password-store"
                | "keychains"
                | "credentials"
                | "credential"
                | "secrets"
                | "privatekeys"
                | "keys"
                | "keyrings"
                | ".pki"
                | ".mozilla"
                | "system32"
                | "database"
                | "databases"
                | "db"
        ) || matches!(
            part.as_str(),
            ".netrc"
                | ".npmrc"
                | ".pypirc"
                | ".git-credentials"
                | ".pgpass"
                | ".authinfo"
                | ".bash_history"
                | ".zsh_history"
                | "authorized_keys"
                | "known_hosts"
                | "cookies"
                | "login data"
                | "web data"
        ) || part.split('.').next().is_some_and(|name| {
            matches!(
                name,
                "credentials"
                    | "credential"
                    | "secrets"
                    | "token"
                    | "tokens"
                    | "private_key"
                    | "private-key"
            )
        }) || part == ".env"
            || part.starts_with(".env.")
            || part.starts_with("id_rsa")
            || part.starts_with("id_ed25519")
            || part.starts_with("id_ecdsa")
            || part.split(['.', '-']).skip(1).any(|suffix| {
                matches!(
                    suffix,
                    "pem"
                        | "key"
                        | "p8"
                        | "p12"
                        | "pfx"
                        | "jks"
                        | "keystore"
                        | "db"
                        | "sqlite"
                        | "sqlite3"
                        | "kdbx"
                        | "wallet"
                )
            })
    });
    let system = [
        "/etc",
        "/private/etc",
        "/proc",
        "/sys",
        "/dev",
        "/var/db",
        "/private/var/db",
    ]
    .iter()
    .any(|root| path.starts_with(root));
    let daemon_data = state
        .settings_path
        .as_deref()
        .and_then(|settings| settings.parent())
        .and_then(|directory| dunce::canonicalize(directory).ok())
        .is_some_and(|directory| path.starts_with(directory));
    if denied || system || daemon_data {
        Err("此敏感文件不能通过手机文件预览授权，请在桌面端检查权限")
    } else {
        Ok(())
    }
}
