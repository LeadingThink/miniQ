//! System prompt injection: the `<available_skills>` block.

use crate::store::Skill;

/// Character budget for the block (~4 chars/token, so roughly 3k tokens).
const DEFAULT_BUDGET_CHARS: usize = 12_000;

/// Build the `<available_skills>` prompt block from enabled skills.
///
/// Degradation under budget pressure: full (name + description) -> compact
/// (names only) -> truncated name list. Returns an empty string when no
/// skill is enabled.
pub fn available_skills_block(skills: &[Skill]) -> String {
    available_skills_block_with_budget(skills, DEFAULT_BUDGET_CHARS)
}

pub fn available_skills_block_with_budget(skills: &[Skill], budget: usize) -> String {
    let enabled: Vec<&Skill> = skills.iter().filter(|s| s.enabled).collect();
    if enabled.is_empty() {
        return String::new();
    }

    let full = render(&enabled, true);
    if full.len() <= budget {
        return full;
    }
    let compact = render(&enabled, false);
    if compact.len() <= budget {
        return compact;
    }
    // Last resort: keep as many names as fit.
    let mut kept: Vec<&Skill> = Vec::new();
    for skill in &enabled {
        kept.push(skill);
        if render(&kept, false).len() > budget {
            kept.pop();
            break;
        }
    }
    render(&kept, false)
}

fn render(skills: &[&Skill], with_description: bool) -> String {
    let mut out = String::from(
        "<available_skills>\nWhen a task matches one of these skills, call the \
         `skill_read` tool with its name and follow the steps in its body.\n",
    );
    for skill in skills {
        if with_description {
            out.push_str(&format!(
                "- {}: {}\n",
                skill.meta.name, skill.meta.description
            ));
        } else {
            out.push_str(&format!("- {}\n", skill.meta.name));
        }
    }
    out.push_str("</available_skills>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse_skill_md;
    use crate::store::{Skill, SkillSource};

    fn skill(name: &str, description: &str, enabled: bool) -> Skill {
        let (meta, _) = parse_skill_md(&format!(
            "---\nname: {name}\ndescription: {description}\n---\nbody"
        ))
        .unwrap();
        Skill {
            meta,
            source: SkillSource::User,
            enabled,
            dir: None,
        }
    }

    #[test]
    fn includes_only_enabled() {
        let skills = vec![
            skill("a-skill", "does A", true),
            skill("b-skill", "does B", false),
        ];
        let block = available_skills_block(&skills);
        assert!(block.contains("a-skill: does A"));
        assert!(!block.contains("b-skill"));
    }

    #[test]
    fn empty_when_none_enabled() {
        assert_eq!(available_skills_block(&[skill("x-skill", "d", false)]), "");
        assert_eq!(available_skills_block(&[]), "");
    }

    #[test]
    fn budget_degrades_to_names_then_truncates() {
        let long = "x".repeat(300);
        let skills: Vec<Skill> = (0..10)
            .map(|i| skill(&format!("skill-{i}"), &long, true))
            .collect();
        let full = available_skills_block_with_budget(&skills, 100_000);
        assert!(full.contains(&long));

        // Too small for descriptions -> names only.
        let compact = available_skills_block_with_budget(&skills, 400);
        assert!(!compact.contains(&long));
        assert!(compact.contains("skill-0"));

        // Even smaller -> fewer names, but still well-formed.
        let truncated = available_skills_block_with_budget(&skills, 250);
        assert!(truncated.starts_with("<available_skills>"));
        assert!(truncated.ends_with("</available_skills>"));
        assert!(truncated.len() <= 250);
    }
}
