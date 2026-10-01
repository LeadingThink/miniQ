//! Single approval decision point (plan v3 §4.2).
//!
//! `decide_approval` is the only place that turns session mode, agent
//! permission policy, risk and remembered approvals into a verdict. The
//! executor builds an [`ApprovalCtx`] and acts on the returned [`Verdict`].

use miniq_protocol::RiskLevel;

use super::PermissionPolicy;
use crate::approval_rules::RuleMatch;
use crate::state::ApprovalMode;

/// Where a tool comes from; extension tools do not get the built-in
/// "Auto runs medium risk" shortcut (plan v3 §4.3 matrix).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolClass {
    Builtin,
    Extension,
}

pub(crate) struct ApprovalCtx {
    pub mode: ApprovalMode,
    pub policy: PermissionPolicy,
    pub risk: RiskLevel,
    pub class: ToolClass,
    pub allowed_for_session: bool,
    pub rule: RuleMatch,
    /// Calls that no mode or remembered approval may skip (§4.3 item 7).
    pub non_preapprovable: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Allow,
    Ask,
    Deny(&'static str),
}

pub(crate) const DONT_ASK_DENIED: &str =
    "agent permission mode dontAsk denied an action requiring approval";

pub(crate) fn decide_approval(ctx: &ApprovalCtx) -> Verdict {
    match ctx.risk {
        RiskLevel::Blocked => return Verdict::Deny("blocked"),
        RiskLevel::Low if !ctx.non_preapprovable => return Verdict::Allow,
        _ => {}
    }
    let ask = || {
        if ctx.policy == PermissionPolicy::DontAsk {
            Verdict::Deny(DONT_ASK_DENIED)
        } else {
            Verdict::Ask
        }
    };
    if ctx.non_preapprovable {
        return ask();
    }
    if ctx.rule == RuleMatch::Allowed {
        return Verdict::Allow;
    }
    let full = ctx.mode == ApprovalMode::FullAccess;
    let session = ctx.allowed_for_session;
    let builtin_medium = ctx.risk == RiskLevel::Medium && ctx.class == ToolClass::Builtin;
    let pre_approved = ctx.mode != ApprovalMode::AlwaysAsk
        && match ctx.policy {
            PermissionPolicy::AcceptEdits => builtin_medium || full || session,
            PermissionPolicy::DontAsk => full || session,
            PermissionPolicy::Inherit => match ctx.mode {
                ApprovalMode::FullAccess => true,
                // Auto ("替我审批"): built-in medium-risk actions (workspace
                // writes, build/test commands -- checkpointed or reversible) run
                // without asking; high risk and extension tools need the user
                // once per pattern.
                ApprovalMode::Auto => builtin_medium || session,
                ApprovalMode::AlwaysAsk => false,
            },
        };
    if pre_approved {
        Verdict::Allow
    } else {
        ask()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(mode: ApprovalMode, risk: RiskLevel, class: ToolClass) -> ApprovalCtx {
        ApprovalCtx {
            mode,
            policy: PermissionPolicy::Inherit,
            risk,
            class,
            allowed_for_session: false,
            rule: RuleMatch::None,
            non_preapprovable: false,
        }
    }

    const MODES: [ApprovalMode; 3] = [
        ApprovalMode::AlwaysAsk,
        ApprovalMode::Auto,
        ApprovalMode::FullAccess,
    ];

    #[test]
    fn matrix_matches_plan() {
        use ApprovalMode::*;
        use RiskLevel::*;
        use ToolClass::*;
        let cases = [
            (AlwaysAsk, Low, Builtin, Verdict::Allow),
            (AlwaysAsk, Medium, Builtin, Verdict::Ask),
            (Auto, Medium, Builtin, Verdict::Allow),
            (Auto, Medium, Extension, Verdict::Ask),
            (Auto, High, Builtin, Verdict::Ask),
            (FullAccess, Medium, Extension, Verdict::Allow),
            (FullAccess, High, Builtin, Verdict::Allow),
            (FullAccess, Blocked, Builtin, Verdict::Deny("blocked")),
        ];
        for (mode, risk, class, expected) in cases {
            assert_eq!(
                decide_approval(&ctx(mode, risk, class)),
                expected,
                "{mode:?} {risk:?} {class:?}"
            );
        }
    }

    #[test]
    fn non_preapprovable_always_asks_or_denies() {
        for mode in MODES {
            let mut c = ctx(mode, RiskLevel::Low, ToolClass::Extension);
            c.non_preapprovable = true;
            c.rule = RuleMatch::Allowed;
            c.allowed_for_session = true;
            assert_eq!(decide_approval(&c), Verdict::Ask, "{mode:?}");
            c.policy = PermissionPolicy::DontAsk;
            assert_eq!(decide_approval(&c), Verdict::Deny(DONT_ASK_DENIED));
        }
    }

    #[test]
    fn always_allow_rule_beats_mode_but_stale_rule_does_not() {
        for mode in MODES {
            let mut c = ctx(mode, RiskLevel::High, ToolClass::Extension);
            c.rule = RuleMatch::Allowed;
            assert_eq!(decide_approval(&c), Verdict::Allow, "{mode:?}");
        }
        let mut c = ctx(ApprovalMode::Auto, RiskLevel::High, ToolClass::Extension);
        c.rule = RuleMatch::Stale("descHash");
        assert_eq!(decide_approval(&c), Verdict::Ask);
    }

    #[test]
    fn session_memory_ignored_in_always_ask() {
        let mut c = ctx(ApprovalMode::AlwaysAsk, RiskLevel::High, ToolClass::Builtin);
        c.allowed_for_session = true;
        assert_eq!(decide_approval(&c), Verdict::Ask);
        c.mode = ApprovalMode::Auto;
        assert_eq!(decide_approval(&c), Verdict::Allow);
    }

    #[test]
    fn dont_ask_denies_unless_preapproved() {
        let mut c = ctx(ApprovalMode::Auto, RiskLevel::Medium, ToolClass::Builtin);
        c.policy = PermissionPolicy::DontAsk;
        assert_eq!(decide_approval(&c), Verdict::Deny(DONT_ASK_DENIED));
        c.mode = ApprovalMode::FullAccess;
        assert_eq!(decide_approval(&c), Verdict::Allow);
    }

    /// RT-08: no feature-flag combination can weaken a non-preapprovable
    /// call. Interactive sources (Inherit / AcceptEdits) must Ask; non-
    /// interactive sources (scheduled / background agents run as DontAsk)
    /// must Deny. `ApprovalCtx` is built from settings with every flag
    /// combination, so any future coupling between flags and approval has
    /// to go through this table.
    #[test]
    fn rt08_feature_flags_never_bypass_non_preapprovable() {
        use crate::features::{FeatureFlags, FeatureStage};
        let sources = [
            (PermissionPolicy::Inherit, true),
            (PermissionPolicy::AcceptEdits, true),
            (PermissionPolicy::DontAsk, false),
        ];
        let risks = [RiskLevel::Low, RiskLevel::Medium, RiskLevel::High];
        let rules = [RuleMatch::None, RuleMatch::Allowed, RuleMatch::Stale("x")];
        let mut checked = 0usize;
        for bits in 0u32..(1 << FeatureFlags::COUNT) {
            let mut settings = crate::state::DaemonSettings::default();
            for (i, stage) in settings.features.stages_mut().into_iter().enumerate() {
                *stage = if bits & (1 << i) != 0 {
                    FeatureStage::On
                } else {
                    FeatureStage::Off
                };
            }
            for mode in MODES {
                settings.approval_mode = mode;
                for (policy, interactive) in sources {
                    for risk in risks {
                        for class in [ToolClass::Builtin, ToolClass::Extension] {
                            for rule in &rules {
                                for allowed_for_session in [false, true] {
                                    let c = ApprovalCtx {
                                        mode: settings.approval_mode,
                                        policy,
                                        risk,
                                        class,
                                        allowed_for_session,
                                        rule: rule.clone(),
                                        non_preapprovable: true,
                                    };
                                    let expected = if interactive {
                                        Verdict::Ask
                                    } else {
                                        Verdict::Deny(DONT_ASK_DENIED)
                                    };
                                    assert_eq!(
                                        decide_approval(&c),
                                        expected,
                                        "features={:?} {mode:?} interactive={interactive} {risk:?} {class:?} {rule:?}",
                                        settings.features
                                    );
                                    checked += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
        assert_eq!(checked, 128 * 3 * 3 * 3 * 2 * 3 * 2);
    }
}

#[cfg(test)]
mod allowlist_tests {
    use std::path::{Path, PathBuf};

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// Plan v3 §4.2: approval shortcuts on `FullAccess` must not spread
    /// outside the reviewed allowlist.
    #[test]
    fn fullaccess_checks_stay_allowlisted() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let allowlist = std::fs::read_to_string(root.join("ci/approval-fullaccess-allowlist.txt"))
            .expect("allowlist file");
        let allowed: Vec<&str> = allowlist
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect();
        let mut files = Vec::new();
        rust_files(&root.join("crates"), &mut files);
        let needle = ["ApprovalMode", "::FullAccess"].concat();
        let mut offenders = Vec::new();
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap_or_default();
            if !text.contains(&needle) {
                continue;
            }
            let relative = file
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if !allowed.contains(&relative.as_str()) {
                offenders.push(relative);
            }
        }
        assert!(
            offenders.is_empty(),
            "ApprovalMode::FullAccess used outside ci/approval-fullaccess-allowlist.txt: {offenders:?}"
        );
    }
}
