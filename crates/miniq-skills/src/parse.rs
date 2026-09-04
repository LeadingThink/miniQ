//! SKILL.md parsing and rendering.
//!
//! The same parser validates hand-written, installed and distilled skills,
//! so anything that parses here is guaranteed loadable everywhere.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("SKILL.md must start with a `---` YAML frontmatter block")]
    MissingFrontmatter,
    #[error("frontmatter is not terminated with `---`")]
    UnterminatedFrontmatter,
    #[error("invalid frontmatter: {0}")]
    InvalidYaml(#[from] serde_yaml::Error),
    #[error("invalid skill name: {0} (use lowercase letters, digits and dashes)")]
    InvalidName(String),
    #[error("description must not be empty")]
    EmptyDescription,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillOrigin {
    Bundled,
    #[default]
    User,
    Distilled,
    Installed,
}

fn default_version() -> u32 {
    1
}

/// Frontmatter of a SKILL.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub origin: SkillOrigin,
    #[serde(default)]
    pub requires: SkillRequires,
    /// Empty = no extra restriction.
    #[serde(default)]
    pub allowed_tools: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRequires {
    #[serde(default)]
    pub bins: Vec<String>,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

/// Parse a SKILL.md into (meta, body).
pub fn parse_skill_md(content: &str) -> Result<(SkillMeta, String), ParseError> {
    let content = content.trim_start_matches('\u{feff}');
    let rest = content
        .strip_prefix("---")
        .ok_or(ParseError::MissingFrontmatter)?;
    let end = rest
        .find("\n---")
        .ok_or(ParseError::UnterminatedFrontmatter)?;
    let frontmatter = &rest[..end];
    let body_start = rest[end + 4..].find('\n').map(|i| end + 4 + i + 1);
    let body = match body_start {
        Some(idx) => rest[idx..].trim_start_matches('\n').to_string(),
        None => String::new(),
    };

    let meta: SkillMeta = serde_yaml::from_str(frontmatter)?;
    if !valid_name(&meta.name) {
        return Err(ParseError::InvalidName(meta.name));
    }
    if meta.description.trim().is_empty() {
        return Err(ParseError::EmptyDescription);
    }
    Ok((meta, body))
}

/// Render meta + body back into a SKILL.md string (used when saving
/// distilled or edited skills).
pub fn render_skill_md(meta: &SkillMeta, body: &str) -> String {
    let yaml = serde_yaml::to_string(meta).expect("skill meta serializes");
    format!("---\n{}---\n\n{}", yaml, body.trim_start())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nname: weekly-report\ndescription: Generate a weekly report\nversion: 2\norigin: distilled\nrequires:\n  bins: [git]\n---\n\n## Steps\n1. run git log\n";

    #[test]
    fn parse_roundtrip() {
        let (meta, body) = parse_skill_md(SAMPLE).unwrap();
        assert_eq!(meta.name, "weekly-report");
        assert_eq!(meta.version, 2);
        assert_eq!(meta.origin, SkillOrigin::Distilled);
        assert_eq!(meta.requires.bins, vec!["git"]);
        assert!(body.starts_with("## Steps"));

        let rendered = render_skill_md(&meta, &body);
        let (meta2, body2) = parse_skill_md(&rendered).unwrap();
        assert_eq!(meta2.name, meta.name);
        assert_eq!(body2, body);
    }

    #[test]
    fn defaults_applied() {
        let (meta, _) =
            parse_skill_md("---\nname: simple\ndescription: a simple skill\n---\nbody").unwrap();
        assert_eq!(meta.version, 1);
        assert_eq!(meta.origin, SkillOrigin::User);
        assert!(meta.requires.bins.is_empty());
    }

    #[test]
    fn rejects_bad_input() {
        assert!(matches!(
            parse_skill_md("no frontmatter"),
            Err(ParseError::MissingFrontmatter)
        ));
        assert!(matches!(
            parse_skill_md("---\nname: x\n"),
            Err(ParseError::UnterminatedFrontmatter)
        ));
        assert!(matches!(
            parse_skill_md("---\nname: Bad Name!\ndescription: d\n---\n"),
            Err(ParseError::InvalidName(_))
        ));
        assert!(matches!(
            parse_skill_md("---\nname: ok-name\ndescription: \"\"\n---\n"),
            Err(ParseError::EmptyDescription)
        ));
    }
}
