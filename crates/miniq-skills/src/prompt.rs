//! System prompt injection: the `<available_skills>` block.

use crate::store::Skill;

/// Byte budget for the block. Bundled plugin packs ship a few hundred skills,
/// so the block keeps full descriptions while they fit, then shortens them
/// before ever dropping to bare names.
const DEFAULT_BUDGET_CHARS: usize = 36_000;

/// Per-skill description cap (in characters) used by the shortened tier.
const SHORT_DESCRIPTION_CHARS: usize = 100;

/// Build the `<available_skills>` prompt block from enabled skills.
///
/// Degradation under budget pressure: full (name + description) -> shortened
/// descriptions -> compact (names only) -> truncated name list. Returns an
/// empty string when no skill is enabled.
pub fn available_skills_block(skills: &[Skill]) -> String {
    available_skills_block_with_budget(skills, DEFAULT_BUDGET_CHARS)
}

pub fn available_skills_block_with_budget(skills: &[Skill], budget: usize) -> String {
    let enabled: Vec<&Skill> = skills.iter().filter(|s| s.enabled).collect();
    if enabled.is_empty() {
        return String::new();
    }

    let full = render(&enabled, Some(usize::MAX));
    if full.len() <= budget {
        return full;
    }
    let short = render(&enabled, Some(SHORT_DESCRIPTION_CHARS));
    if short.len() <= budget {
        return short;
    }
    let compact = render(&enabled, None);
    if compact.len() <= budget {
        return compact;
    }
    // Last resort: keep as many names as fit.
    let mut kept: Vec<&Skill> = Vec::new();
    for skill in &enabled {
        kept.push(skill);
        if render(&kept, None).len() > budget {
            kept.pop();
            break;
        }
    }
    render(&kept, None)
}

fn shorten(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

fn render(skills: &[&Skill], description_chars: Option<usize>) -> String {
    let mut out = String::from(
        "<available_skills>\nWhen a task matches one of these skills, call the \
         `skill_read` tool with its name and follow the steps in its body.\n",
    );
    for skill in skills {
        if let Some(max) = description_chars {
            out.push_str(&format!(
                "- {}: {}\n",
                skill.meta.name,
                shorten(&skill.meta.description, max)
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
            dependencies: Vec::new(),
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

        // Too long in full -> descriptions shortened to the per-skill cap.
        let short = available_skills_block_with_budget(&skills, 1_500);
        assert!(!short.contains(&long));
        assert!(short.contains(&format!("{}…", "x".repeat(SHORT_DESCRIPTION_CHARS))));

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
