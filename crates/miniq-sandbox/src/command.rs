//! Shell command risk grading.
//!
//! Commands are split on shell chaining operators and every segment is
//! classified; the whole command gets the highest segment risk. Unknown
//! commands default to `Medium` (they run inside the workspace cwd but we
//! cannot prove they are read-only).

use miniq_protocol::RiskLevel;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Risk {
    pub level: RiskLevel,
    pub reason: String,
}

/// Read-only commands that never modify state.
const LOW_RISK: &[&str] = &[
    "ls", "dir", "cat", "type", "head", "tail", "grep", "rg", "find", "findstr", "pwd", "echo",
    "which", "where", "wc", "diff", "tree", "stat", "file", "du", "df",
];

/// Read-only git subcommands.
const GIT_LOW: &[&str] = &["status", "diff", "log", "show", "branch", "remote", "blame", "shortlog"];

/// Git subcommands that rewrite history or discard work.
const GIT_HIGH: &[&str] = &["push", "reset", "rebase", "clean", "checkout", "restore", "filter-branch"];

/// Commands that reach the network or fetch remote code.
const NETWORK: &[&str] = &["curl", "wget", "ssh", "scp", "nc", "ncat", "telnet", "ftp"];

/// Commands that delete or overwrite data.
const DESTRUCTIVE: &[&str] = &["rm", "rmdir", "del", "erase", "rd", "mkfs", "dd"];

/// Commands that must never run from an agent session.
const BLOCKED: &[&str] = &[
    "shutdown", "reboot", "halt", "poweroff", "format", "diskpart", "bcdedit", "reg", "regedit",
    "sc", "schtasks", "mkfs",
];

/// Substrings that force `Blocked` wherever they appear (defence against
/// simple chaining/quoting tricks).
const BLOCKED_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf ~",
    "rm -rf c:",
    ":(){",         // fork bomb
    "> /dev/sd",
    "sudo rm",
    "format c:",
];

/// Classify one shell command line.
pub fn classify_command(command: &str) -> Risk {
    let lower = command.to_lowercase();
    for pattern in BLOCKED_PATTERNS {
        if lower.contains(pattern) {
            return Risk {
                level: RiskLevel::Blocked,
                reason: format!("contains blocked pattern: {pattern}"),
            };
        }
    }

    let mut worst = Risk {
        level: RiskLevel::Low,
        reason: "read-only command".to_string(),
    };
    for segment in split_segments(command) {
        let risk = classify_segment(&segment);
        if risk.level > worst.level {
            worst = risk;
        }
    }
    worst
}

/// Split on `&&`, `||`, `;`, `|` and newlines, keeping segment text.
fn split_segments(command: &str) -> Vec<String> {
    command
        .split(['\n', ';'])
        .flat_map(|part| part.split("&&"))
        .flat_map(|part| part.split("||"))
        .flat_map(|part| part.split('|'))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn classify_segment(segment: &str) -> Risk {
    let tokens: Vec<&str> = segment.split_whitespace().collect();
    let Some(&program) = tokens.first() else {
        return Risk {
            level: RiskLevel::Low,
            reason: "empty segment".into(),
        };
    };
    // Strip common path prefixes and extensions: `/usr/bin/rm`, `rm.exe`.
    let program = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .trim_end_matches(".exe")
        .to_lowercase();

    if BLOCKED.contains(&program.as_str()) {
        return Risk {
            level: RiskLevel::Blocked,
            reason: format!("blocked command: {program}"),
        };
    }
    if DESTRUCTIVE.contains(&program.as_str()) {
        return Risk {
            level: RiskLevel::High,
            reason: format!("destructive command: {program}"),
        };
    }
    if NETWORK.contains(&program.as_str()) {
        return Risk {
            level: RiskLevel::High,
            reason: format!("network command: {program}"),
        };
    }
    if program == "git" {
        let sub = tokens.get(1).copied().unwrap_or("");
        if GIT_LOW.contains(&sub) {
            return Risk {
                level: RiskLevel::Low,
                reason: format!("read-only git {sub}"),
            };
        }
        if GIT_HIGH.contains(&sub) {
            return Risk {
                level: RiskLevel::High,
                reason: format!("git {sub} modifies history or discards work"),
            };
        }
        return Risk {
            level: RiskLevel::Medium,
            reason: format!("git {sub} modifies repository state"),
        };
    }
    if LOW_RISK.contains(&program.as_str()) {
        return Risk {
            level: RiskLevel::Low,
            reason: format!("read-only command: {program}"),
        };
    }
    Risk {
        level: RiskLevel::Medium,
        reason: format!("unrecognized command runs in workspace: {program}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_is_low() {
        assert_eq!(classify_command("ls -la").level, RiskLevel::Low);
        assert_eq!(classify_command("git status").level, RiskLevel::Low);
        assert_eq!(classify_command("rg foo src").level, RiskLevel::Low);
    }

    #[test]
    fn build_and_tests_are_medium() {
        assert_eq!(classify_command("cargo test").level, RiskLevel::Medium);
        assert_eq!(classify_command("npm install").level, RiskLevel::Medium);
        assert_eq!(classify_command("git commit -m x").level, RiskLevel::Medium);
    }

    #[test]
    fn destructive_and_network_are_high() {
        assert_eq!(classify_command("rm -r target").level, RiskLevel::High);
        assert_eq!(classify_command("curl https://example.com").level, RiskLevel::High);
        assert_eq!(classify_command("git push --force").level, RiskLevel::High);
        assert_eq!(classify_command("git reset --hard").level, RiskLevel::High);
    }

    #[test]
    fn chained_command_takes_worst() {
        assert_eq!(classify_command("ls && rm -r target").level, RiskLevel::High);
        assert_eq!(classify_command("cat a.txt | grep x").level, RiskLevel::Low);
        assert_eq!(classify_command("echo hi; cargo build").level, RiskLevel::Medium);
    }

    #[test]
    fn blocked_commands() {
        assert_eq!(classify_command("shutdown /s").level, RiskLevel::Blocked);
        assert_eq!(classify_command("rm -rf /").level, RiskLevel::Blocked);
        assert_eq!(classify_command("echo x && sudo rm -rf /tmp").level, RiskLevel::Blocked);
        assert_eq!(classify_command("format c:").level, RiskLevel::Blocked);
    }

    #[test]
    fn path_prefixed_program_detected() {
        assert_eq!(classify_command("/usr/bin/rm -r x").level, RiskLevel::High);
        assert_eq!(classify_command(r"C:\Windows\System32\shutdown.exe /s").level, RiskLevel::Blocked);
    }
}
