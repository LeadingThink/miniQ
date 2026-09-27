//! Environment allowlist for helper subprocesses (stdio MCP servers, Node
//! plugins, hooks). Children never inherit the daemon's full environment:
//! only a small set of variables needed to run programs is passed through,
//! plus the explicitly configured `extra` variables.
//!
//! `MINIQ_CREDENTIALS_PASSPHRASE` is never passed to a child, not even when a
//! configuration lists it explicitly.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};

/// Secret that unlocks the credential store; never forwarded to children.
pub const CREDENTIALS_PASSPHRASE_VAR: &str = "MINIQ_CREDENTIALS_PASSPHRASE";

/// Variables inherited on every platform (plus any `LC_*`).
const COMMON_ALLOWED: &[&str] = &["PATH", "HOME", "LANG", "TMPDIR", "USER", "SHELL"];

/// Extra variables inherited on Windows so programs can start at all.
const WINDOWS_ALLOWED: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "PATHEXT",
    "COMSPEC",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
];

fn name_eq(name: &str, candidate: &str, windows: bool) -> bool {
    if windows {
        name.eq_ignore_ascii_case(candidate)
    } else {
        name == candidate
    }
}

/// Whether `name` is the credentials passphrase variable.
pub fn is_credentials_passphrase(name: &str) -> bool {
    name_eq(name, CREDENTIALS_PASSPHRASE_VAR, cfg!(windows))
}

fn is_passphrase(name: &OsStr, windows: bool) -> bool {
    name.to_str()
        .is_some_and(|name| name_eq(name, CREDENTIALS_PASSPHRASE_VAR, windows))
}

fn is_allowed(name: &OsStr, windows: bool) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    if COMMON_ALLOWED
        .iter()
        .any(|candidate| name_eq(name, candidate, windows))
    {
        return true;
    }
    if name.starts_with("LC_") || (windows && name.to_ascii_uppercase().starts_with("LC_")) {
        return true;
    }
    windows
        && WINDOWS_ALLOWED
            .iter()
            .any(|candidate| name_eq(name, candidate, windows))
}

/// Pure form of the allowlist: filter `inherited`, then overlay `extra`.
/// `extra` entries naming `MINIQ_CREDENTIALS_PASSPHRASE` are dropped and
/// reported through `tracing::warn!`.
pub fn build_env<I, K, V>(
    inherited: I,
    extra: &BTreeMap<String, String>,
    windows: bool,
) -> BTreeMap<OsString, OsString>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<OsString>,
    V: Into<OsString>,
{
    let mut env = BTreeMap::new();
    for (name, value) in inherited {
        let name = name.into();
        if is_allowed(&name, windows) && !is_passphrase(&name, windows) {
            env.insert(name, value.into());
        }
    }
    if windows
        && !env
            .keys()
            .any(|name| name.eq_ignore_ascii_case("SystemDrive"))
    {
        let drive = env
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("SystemRoot"))
            .and_then(|(_, root)| root.to_str().and_then(|root| root.get(..2)))
            .map(OsString::from);
        if let Some(drive) = drive {
            env.insert(OsString::from("SystemDrive"), drive);
        }
    }
    for (name, value) in extra {
        if is_passphrase(OsStr::new(name), windows) {
            tracing::warn!(
                variable = %name,
                "refusing to pass the credentials passphrase to a subprocess; remove it from the configured env"
            );
            continue;
        }
        if windows {
            // Windows names are case-insensitive: drop any inherited spelling
            // so the configured value wins deterministically.
            env.retain(|existing: &OsString, _| !existing.eq_ignore_ascii_case(name));
        }
        env.insert(OsString::from(name), OsString::from(value));
    }
    env
}

/// Allowlisted environment for the current process and platform.
pub fn allowlisted_env(extra: &BTreeMap<String, String>) -> BTreeMap<OsString, OsString> {
    build_env(std::env::vars_os(), extra, cfg!(windows))
}

/// Clear `command`'s environment and apply the allowlist plus `extra`.
/// For `tokio::process::Command`, pass `command.as_std_mut()`.
pub fn apply_allowlist(command: &mut std::process::Command, extra: &BTreeMap<String, String>) {
    command.env_clear();
    command.envs(allowlisted_env(extra));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inherited() -> Vec<(String, String)> {
        vec![
            ("PATH".into(), "/usr/bin".into()),
            ("HOME".into(), "/home/me".into()),
            ("LANG".into(), "en_US.UTF-8".into()),
            ("LC_ALL".into(), "en_US.UTF-8".into()),
            ("TMPDIR".into(), "/tmp".into()),
            ("USER".into(), "me".into()),
            ("SHELL".into(), "/bin/zsh".into()),
            ("AWS_SECRET_ACCESS_KEY".into(), "secret".into()),
            ("OPENAI_API_KEY".into(), "sk-secret".into()),
            (CREDENTIALS_PASSPHRASE_VAR.into(), "hunter2".into()),
            ("SystemRoot".into(), "C:\\Windows".into()),
        ]
    }

    fn keys(env: &BTreeMap<OsString, OsString>) -> Vec<String> {
        env.keys()
            .map(|key| key.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn unix_passes_only_allowlisted_variables() {
        let env = build_env(inherited(), &BTreeMap::new(), false);
        assert_eq!(
            keys(&env),
            vec!["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "USER"]
        );
    }

    #[test]
    fn extra_variables_are_added_and_override() {
        let extra = BTreeMap::from([
            ("API_TOKEN".to_string(), "configured".to_string()),
            ("PATH".to_string(), "/opt/bin".to_string()),
        ]);
        let env = build_env(inherited(), &extra, false);
        assert_eq!(env.get(OsStr::new("API_TOKEN")).unwrap(), "configured");
        assert_eq!(env.get(OsStr::new("PATH")).unwrap(), "/opt/bin");
        assert!(!env.contains_key(OsStr::new("OPENAI_API_KEY")));
    }

    #[test]
    fn credentials_passphrase_is_never_passed() {
        let has_passphrase = |env: &BTreeMap<OsString, OsString>| {
            env.keys()
                .any(|key| key.eq_ignore_ascii_case(CREDENTIALS_PASSPHRASE_VAR))
        };
        let extra = BTreeMap::from([(
            CREDENTIALS_PASSPHRASE_VAR.to_string(),
            "explicit".to_string(),
        )]);
        for windows in [false, true] {
            let env = build_env(inherited(), &extra, windows);
            assert!(!has_passphrase(&env), "windows={windows}");
        }
        let lowercase = BTreeMap::from([(
            CREDENTIALS_PASSPHRASE_VAR.to_ascii_lowercase(),
            "explicit".to_string(),
        )]);
        assert!(!has_passphrase(&build_env(inherited(), &lowercase, true)));
    }

    #[test]
    fn windows_keeps_runtime_variables_case_insensitively() {
        let inherited = vec![
            ("Path".to_string(), "C:\\bin".to_string()),
            ("SystemRoot".to_string(), "C:\\Windows".to_string()),
            ("ComSpec".to_string(), "C:\\Windows\\cmd.exe".to_string()),
            ("APPDATA".to_string(), "C:\\Users\\me\\AppData".to_string()),
            ("GITHUB_TOKEN".to_string(), "secret".to_string()),
        ];
        let env = build_env(inherited, &BTreeMap::new(), true);
        assert_eq!(
            keys(&env),
            vec!["APPDATA", "ComSpec", "Path", "SystemDrive", "SystemRoot"]
        );
        assert_eq!(env.get(OsStr::new("SystemDrive")).unwrap(), "C:");

        let extra = BTreeMap::from([("PATH".to_string(), "D:\\tools".to_string())]);
        let env = build_env(
            vec![("Path".to_string(), "C:\\bin".to_string())],
            &extra,
            true,
        );
        assert_eq!(keys(&env), vec!["PATH"]);
    }

    #[test]
    fn windows_only_variables_are_dropped_on_unix() {
        let env = build_env(
            vec![("APPDATA".to_string(), "x".to_string())],
            &BTreeMap::new(),
            false,
        );
        assert!(env.is_empty());
    }

    #[test]
    fn apply_allowlist_clears_inherited_environment() {
        let mut command = std::process::Command::new("true");
        command.env("OPENAI_API_KEY", "leak");
        apply_allowlist(
            &mut command,
            &BTreeMap::from([("CUSTOM".to_string(), "1".to_string())]),
        );
        let envs = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|_| key.to_string_lossy().into_owned()))
            .collect::<Vec<_>>();
        assert!(envs.contains(&"CUSTOM".to_string()));
        assert!(!envs.contains(&"OPENAI_API_KEY".to_string()));
        assert!(!envs.contains(&CREDENTIALS_PASSPHRASE_VAR.to_string()));
    }
}
