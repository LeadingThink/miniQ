//! Skill learning: distill a completed task transcript into a SKILL.md, and
//! refine an existing skill with new evidence.
//!
//! Model access is injected behind [`SkillInference`] so this crate stays
//! free of provider dependencies. Every draft is validated with the same
//! parser the loader uses, so a learned skill is guaranteed installable.

use async_trait::async_trait;

use crate::parse::{parse_skill_md, ParseError};

/// Minimal inference interface the daemon implements over its provider.
#[async_trait]
pub trait SkillInference: Send + Sync {
    async fn complete(&self, system: &str, user: &str) -> Result<String, String>;
}

#[derive(Debug, thiserror::Error)]
pub enum LearnError {
    #[error("inference failed: {0}")]
    Inference(String),
    #[error("model produced an invalid skill: {0}")]
    InvalidDraft(#[from] ParseError),
    #[error("model produced an unrecognized response")]
    Unrecognized,
}

/// Result of a distillation attempt.
#[derive(Debug)]
pub enum DistillOutcome {
    /// A validated SKILL.md draft plus any sensitive-content warnings.
    Draft {
        content: String,
        name: String,
        description: String,
        warnings: Vec<String>,
    },
    /// The session is not worth a skill (pure Q&A etc.).
    Skipped { reason: String },
}

/// Result of a refinement attempt.
#[derive(Debug)]
pub enum RefineOutcome {
    /// Updated SKILL.md (version already bumped by the model, verified here).
    Updated {
        content: String,
        warnings: Vec<String>,
    },
    /// The existing skill already covers the new evidence.
    Kept,
}

const DISTILL_SYSTEM: &str = r#"You distill a completed agent task transcript into a reusable skill file.

Output EXACTLY one of:
1. `SKIP: <one-line reason>` — when the session is pure question answering, trivial (fewer than 2 tool calls), or too specific to ever recur.
2. A complete SKILL.md file, nothing else, in this shape:

---
name: <lowercase-dash-name derived from the task, stable across re-runs>
description: <one line: what task this skill completes>
version: 1
origin: distilled
---

## 适用场景
<when to use this skill>

## 步骤(写明每步用哪个工具)
1. <step naming the EXACT tool, e.g. file_glob / doc_read / shell_run, with key parameters>
...

## 注意事项(真实踩过的坑)
- <only pitfalls that actually happened in the transcript; omit the section if none>

## 如何确认完成
<verifiable completion criteria>

Rules:
- Steps must name exact tool names used in the transcript.
- NEVER include API keys, tokens, passwords, or personal data.
- Generalize file names into placeholders where the pattern matters more than the name.
- Write body text in the language the user used."#;

const REFINE_SYSTEM: &str = r#"You maintain a reusable skill file. Given the existing SKILL.md and a new task transcript that used this skill, decide:

1. If the existing skill already covers everything learned: output exactly `KEEP`.
2. Otherwise output the complete updated SKILL.md (same name, version incremented by 1, origin unchanged), folding in new steps or pitfalls. Nothing else.

Rules: never include secrets; keep the body language unchanged."#;

/// Patterns that must never appear in a saved skill.
const SENSITIVE_PATTERNS: &[(&str, &str)] = &[
    (
        r"(?i)(api[_-]?key|secret|password|token)\s*[:=]\s*['\x22]?[A-Za-z0-9_\-./+]{8,}",
        "credential assignment",
    ),
    (r"sk-[A-Za-z0-9]{16,}", "OpenAI-style API key"),
    (r"tvly-[A-Za-z0-9]{8,}", "Tavily API key"),
    (r"(?i)bearer\s+[A-Za-z0-9._\-]{16,}", "bearer token"),
];

/// Scan a draft for sensitive content. Returns human-readable warnings.
pub fn scan_sensitive(content: &str) -> Vec<String> {
    let mut warnings = Vec::new();
    for (pattern, label) in SENSITIVE_PATTERNS {
        let re = regex::Regex::new(pattern).expect("static pattern compiles");
        for hit in re.find_iter(content) {
            let shown: String = hit.as_str().chars().take(24).collect();
            warnings.push(format!("{label}: `{shown}...`"));
        }
    }
    warnings
}

fn strip_code_fence(raw: &str) -> &str {
    let trimmed = raw.trim();
    let Some(inner) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    // Drop an optional language tag line, then the closing fence.
    let inner = inner
        .strip_prefix("markdown")
        .or(inner.strip_prefix("md"))
        .unwrap_or(inner);
    let inner = inner.trim_start_matches('\n');
    inner.strip_suffix("```").map(str::trim).unwrap_or(inner)
}

/// Distill a transcript into a skill draft.
pub async fn distill_skill(
    transcript: &str,
    existing_names: &[String],
    inference: &dyn SkillInference,
) -> Result<DistillOutcome, LearnError> {
    let user = format!(
        "Existing skill names (avoid collisions unless this IS the same task):\n{}\n\n\
         Task transcript:\n{transcript}",
        if existing_names.is_empty() {
            "(none)".to_string()
        } else {
            existing_names.join(", ")
        }
    );
    let raw = inference
        .complete(DISTILL_SYSTEM, &user)
        .await
        .map_err(LearnError::Inference)?;
    let cleaned = strip_code_fence(&raw);

    if let Some(reason) = cleaned.strip_prefix("SKIP:") {
        return Ok(DistillOutcome::Skipped {
            reason: reason.trim().to_string(),
        });
    }
    if !cleaned.starts_with("---") {
        return Err(LearnError::Unrecognized);
    }
    let (meta, _) = parse_skill_md(cleaned)?;
    Ok(DistillOutcome::Draft {
        warnings: scan_sensitive(cleaned),
        content: cleaned.to_string(),
        name: meta.name,
        description: meta.description,
    })
}

/// Refine an existing skill with a new transcript.
pub async fn refine_skill(
    existing: &str,
    transcript: &str,
    inference: &dyn SkillInference,
) -> Result<RefineOutcome, LearnError> {
    let user = format!("Existing SKILL.md:\n{existing}\n\nNew task transcript:\n{transcript}");
    let raw = inference
        .complete(REFINE_SYSTEM, &user)
        .await
        .map_err(LearnError::Inference)?;
    let cleaned = strip_code_fence(&raw);

    if cleaned.trim() == "KEEP" {
        return Ok(RefineOutcome::Kept);
    }
    if !cleaned.starts_with("---") {
        return Err(LearnError::Unrecognized);
    }
    parse_skill_md(cleaned)?;
    Ok(RefineOutcome::Updated {
        warnings: scan_sensitive(cleaned),
        content: cleaned.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeInference(String);

    #[async_trait]
    impl SkillInference for FakeInference {
        async fn complete(&self, _system: &str, _user: &str) -> Result<String, String> {
            Ok(self.0.clone())
        }
    }

    const VALID_SKILL: &str = "---\nname: fill-report\ndescription: fill a weekly report\nversion: 1\norigin: distilled\n---\n\n## 步骤\n1. use file_glob\n";

    #[tokio::test]
    async fn distill_valid_draft() {
        let inference = FakeInference(VALID_SKILL.to_string());
        let outcome = distill_skill("transcript", &[], &inference).await.unwrap();
        let DistillOutcome::Draft { name, warnings, .. } = outcome else {
            panic!("expected draft");
        };
        assert_eq!(name, "fill-report");
        assert!(warnings.is_empty());
    }

    #[tokio::test]
    async fn distill_skip_and_garbage() {
        let inference = FakeInference("SKIP: pure question answering".into());
        let DistillOutcome::Skipped { reason } = distill_skill("t", &[], &inference).await.unwrap()
        else {
            panic!("expected skip");
        };
        assert_eq!(reason, "pure question answering");

        let inference = FakeInference("here is your skill! enjoy".into());
        assert!(matches!(
            distill_skill("t", &[], &inference).await,
            Err(LearnError::Unrecognized)
        ));
    }

    #[tokio::test]
    async fn distill_strips_code_fence_and_validates() {
        let inference = FakeInference(format!("```markdown\n{VALID_SKILL}```"));
        assert!(matches!(
            distill_skill("t", &[], &inference).await.unwrap(),
            DistillOutcome::Draft { .. }
        ));

        let inference = FakeInference("---\nname: BAD NAME\ndescription: x\n---\nbody".into());
        assert!(matches!(
            distill_skill("t", &[], &inference).await,
            Err(LearnError::InvalidDraft(_))
        ));
    }

    #[tokio::test]
    async fn sensitive_scan_flags_secrets() {
        let dirty = format!("{VALID_SKILL}\napi_key = \"sk-abcdefghijklmnop1234\"\n");
        let inference = FakeInference(dirty);
        let DistillOutcome::Draft { warnings, .. } =
            distill_skill("t", &[], &inference).await.unwrap()
        else {
            panic!("expected draft");
        };
        assert!(!warnings.is_empty());
    }

    #[tokio::test]
    async fn refine_keep_and_update() {
        let inference = FakeInference("KEEP".into());
        assert!(matches!(
            refine_skill(VALID_SKILL, "t", &inference).await.unwrap(),
            RefineOutcome::Kept
        ));

        let updated = VALID_SKILL.replace("version: 1", "version: 2");
        let inference = FakeInference(updated.clone());
        let RefineOutcome::Updated { content, .. } =
            refine_skill(VALID_SKILL, "t", &inference).await.unwrap()
        else {
            panic!("expected update");
        };
        assert!(content.contains("version: 2"));
    }
}
