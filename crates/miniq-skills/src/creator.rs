//! Skill creation from a plain-language goal, plus structural checks that
//! every draft (created, distilled or hand-edited) passes before install.
//!
//! Generation reuses [`SkillInference`]; validation is deterministic so the
//! desktop can re-run it on every edit without a model call.

use serde::Serialize;

use crate::learn::{scan_sensitive, strip_code_fence, LearnError, SkillInference};
use crate::parse::parse_skill_md;

const CREATE_SYSTEM: &str = r#"You write a reusable skill file for the miniQ desktop agent from a user's description of a recurring task.

Output ONLY a complete SKILL.md, nothing else:

---
name: <lowercase-dash-name, at most 64 characters>
displayName: <short human label in the user's language>
description: <one sentence: what the skill does AND when it should be used>
version: 1
origin: user
---

## 适用场景
<when to use it; add "不适用" only when misuse is likely>

## 步骤
1. <one action per step; name the miniQ tool when it matters, e.g. file_grep, doc_read, shell_run, agent_run>

## 如何确认完成
<checks the agent can actually verify>

When the user assigns different models to sub-tasks, add an `agents` list to the frontmatter
and delegate each role with agent_run in the steps:

agents:
  - role: reader
    model: <model exactly as the user named it>
    task: <what this sub-agent does>
    readOnly: true

Guidance:
- The agent is already capable. Keep only instructions that change its decisions; drop generic advice.
- Match strictness to risk: fixed steps only for fragile, destructive or externally visible actions.
- External side effects (sending, publishing, deleting, paying) must state the approval point.
- Never include API keys, tokens, passwords, personal data or machine-specific absolute paths; use placeholders.
- Do not invent tools, files or facts the user did not mention.
- Write the body in the user's language."#;

/// A validated draft generated from a goal.
#[derive(Debug)]
pub struct CreatedSkill {
    pub content: String,
    pub name: String,
    pub description: String,
}

/// Generate a SKILL.md draft from a natural-language goal.
pub async fn create_skill(
    goal: &str,
    name_hint: Option<&str>,
    existing_names: &[String],
    inference: &dyn SkillInference,
) -> Result<CreatedSkill, LearnError> {
    let names = if existing_names.is_empty() {
        "(none)".to_string()
    } else {
        existing_names.join(", ")
    };
    let hint = name_hint
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| format!("Preferred skill name: {name}\n"))
        .unwrap_or_default();
    let user = format!(
        "{hint}Existing skill names (choose a different name):\n{names}\n\nWhat the skill should do:\n{goal}"
    );
    let raw = inference
        .complete(CREATE_SYSTEM, &user)
        .await
        .map_err(LearnError::Inference)?;
    let cleaned = strip_code_fence(&raw);
    if !cleaned.starts_with("---") {
        return Err(LearnError::Unrecognized);
    }
    let (meta, _) = parse_skill_md(cleaned)?;
    Ok(CreatedSkill {
        content: cleaned.to_string(),
        name: meta.name,
        description: meta.description,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckLevel {
    Ok,
    Warning,
    Error,
}

/// One user-facing validation result.
#[derive(Debug, Clone, Serialize)]
pub struct SkillCheck {
    pub id: &'static str,
    pub level: CheckLevel,
    pub message: String,
}

/// Result of validating a draft before install.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillValidation {
    pub valid: bool,
    pub name: Option<String>,
    pub existing_skill: bool,
    pub checks: Vec<SkillCheck>,
}

fn check(id: &'static str, level: CheckLevel, message: impl Into<String>) -> SkillCheck {
    SkillCheck {
        id,
        level,
        message: message.into(),
    }
}

/// Deterministic checks shared by create, distill and manual edits.
pub fn validate_skill(content: &str, existing_names: &[String]) -> SkillValidation {
    let (meta, body) = match parse_skill_md(content) {
        Ok(parsed) => parsed,
        Err(error) => {
            return SkillValidation {
                valid: false,
                name: None,
                existing_skill: false,
                checks: vec![check("format", CheckLevel::Error, error.to_string())],
            }
        }
    };
    let mut checks = vec![check("format", CheckLevel::Ok, "格式与名称有效")];
    let description = meta.description.chars().count();
    checks.push(if description < 12 {
        check(
            "description",
            CheckLevel::Warning,
            "描述过短：写清做什么以及何时使用，模型才会在合适时调用",
        )
    } else if description > 300 {
        check(
            "description",
            CheckLevel::Warning,
            "描述过长：它在每轮都会进入上下文，建议控制在 300 字以内",
        )
    } else {
        check("description", CheckLevel::Ok, "描述长度合适")
    });
    let body_text = body.trim();
    checks.push(if body_text.chars().count() < 40 {
        check(
            "body",
            CheckLevel::Warning,
            "正文过短：至少写明步骤和完成标准",
        )
    } else {
        check("body", CheckLevel::Ok, "正文包含说明")
    });
    let has_completion = [
        "如何确认完成",
        "完成标准",
        "验收",
        "Done",
        "Verify",
        "Verification",
    ]
    .iter()
    .any(|marker| body_text.contains(marker));
    checks.push(if has_completion {
        check("completion", CheckLevel::Ok, "包含完成标准")
    } else {
        check(
            "completion",
            CheckLevel::Warning,
            "缺少完成标准：建议加入“如何确认完成”",
        )
    });
    let warnings = scan_sensitive(content);
    checks.push(if warnings.is_empty() {
        check("secrets", CheckLevel::Ok, "未发现密钥或令牌")
    } else {
        check(
            "secrets",
            CheckLevel::Error,
            format!("疑似敏感内容：{}", warnings.join("；")),
        )
    });
    if !meta.agents.is_empty() {
        let unnamed = meta.agents.iter().any(|agent| agent.role.trim().is_empty());
        let mut roles: Vec<&str> = meta.agents.iter().map(|agent| agent.role.trim()).collect();
        roles.sort_unstable();
        roles.dedup();
        checks.push(if unnamed || roles.len() != meta.agents.len() {
            check(
                "agents",
                CheckLevel::Error,
                "子任务角色必须有名称且互不重复",
            )
        } else {
            check(
                "agents",
                CheckLevel::Ok,
                format!("声明了 {} 个子任务角色", meta.agents.len()),
            )
        });
    }
    let existing_skill = existing_names.iter().any(|name| name == &meta.name);
    if existing_skill {
        checks.push(check(
            "name",
            CheckLevel::Warning,
            format!("已存在同名技能 {}，保存会覆盖并保留旧版本备份", meta.name),
        ));
    }
    SkillValidation {
        valid: checks.iter().all(|item| item.level != CheckLevel::Error),
        name: Some(meta.name),
        existing_skill,
        checks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct Fake(String);

    #[async_trait]
    impl SkillInference for Fake {
        async fn complete(&self, _system: &str, user: &str) -> Result<String, String> {
            assert!(user.contains("周报"));
            Ok(self.0.clone())
        }
    }

    const GOOD: &str = "---\nname: weekly-report\ndisplayName: 周报整理\ndescription: 汇总本周提交与会议记录，生成周报草稿；用户要求写周报时使用\nversion: 1\norigin: user\n---\n\n## 步骤\n1. 用 shell_run 读取本周 git log。\n2. 用 doc_write 生成周报。\n\n## 如何确认完成\n周报文件存在且包含本周每个工作日。\n";

    #[tokio::test]
    async fn creates_a_validated_draft_from_a_goal() {
        let fake = Fake(format!("```markdown\n{GOOD}```"));
        let created = create_skill("每周五整理周报", None, &[], &fake)
            .await
            .unwrap();
        assert_eq!(created.name, "weekly-report");
        assert!(created.content.starts_with("---"));
    }

    #[tokio::test]
    async fn rejects_non_skill_output() {
        let fake = Fake("好的，下面是周报技能".into());
        assert!(matches!(
            create_skill("周报", None, &[], &fake).await,
            Err(LearnError::Unrecognized)
        ));
    }

    #[test]
    fn validation_reports_errors_warnings_and_collisions() {
        let ok = validate_skill(GOOD, &[]);
        assert!(ok.valid);
        assert!(ok.checks.iter().all(|c| c.level == CheckLevel::Ok));

        let existing = validate_skill(GOOD, &["weekly-report".into()]);
        assert!(existing.valid && existing.existing_skill);

        let secret = GOOD.replace("本周提交", "api_key=sk-abcdefghijklmnopqrstu");
        assert!(!validate_skill(&secret, &[]).valid);

        let roles = GOOD.replace("origin: user\n", "origin: user\nagents:\n  - role: reader\n    model: gemini 3.8\n    readOnly: true\n  - role: writer\n    model: gpt-6.1-sol\n");
        let parsed = validate_skill(&roles, &[]);
        assert!(parsed.valid);
        assert!(parsed
            .checks
            .iter()
            .any(|c| c.id == "agents" && c.level == CheckLevel::Ok));
        let duplicate = roles.replace("role: writer", "role: reader");
        assert!(!validate_skill(&duplicate, &[]).valid);

        let broken = validate_skill("no frontmatter", &[]);
        assert!(!broken.valid && broken.name.is_none());

        let thin = "---\nname: thin\ndescription: x\n---\nshort";
        let thin = validate_skill(thin, &[]);
        assert!(thin.valid);
        assert!(
            thin.checks
                .iter()
                .filter(|c| c.level == CheckLevel::Warning)
                .count()
                >= 3
        );
    }
}
