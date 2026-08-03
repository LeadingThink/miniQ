//! miniq-skills: the skill system.
//!
//! A skill is a directory with a `SKILL.md` (YAML frontmatter + markdown
//! body) and optional sidecar files (scripts/, templates/, references/).
//! Skills are knowledge, not an execution channel: any scripts they carry
//! are run by the agent through `shell_run` and inherit approval/sandboxing.
//!
//! This crate only handles parsing, discovery and prompt generation. Model
//! calls for distill/refine (M4) are injected behind a trait by the daemon.

mod learn;
mod parse;
mod prompt;
mod store;

pub use learn::{
    distill_skill, refine_skill, scan_sensitive, DistillOutcome, LearnError, RefineOutcome,
    SkillInference,
};
pub use parse::{parse_skill_md, render_skill_md, ParseError, SkillMeta, SkillOrigin};
pub use prompt::available_skills_block;
pub use store::{BundledSkill, Skill, SkillDetail, SkillSource, SkillStore, StoreError};

/// Skills compiled into the miniQ binary.
pub fn bundled_skills() -> Vec<BundledSkill> {
    vec![
        BundledSkill {
            content: include_str!("../assets/organize-directory/SKILL.md"),
        },
        BundledSkill {
            content: include_str!("../assets/summarize-changes/SKILL.md"),
        },
        BundledSkill {
            content: include_str!("../assets/email-draft/SKILL.md"),
        },
    ]
}

#[cfg(test)]
mod bundled_tests {
    #[test]
    fn bundled_skills_parse() {
        for bundled in super::bundled_skills() {
            let (meta, body) =
                super::parse_skill_md(bundled.content).expect("bundled skill parses");
            assert!(!body.is_empty(), "{} has empty body", meta.name);
        }
    }
}
