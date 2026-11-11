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

/// Budget for a turn-scoped subset. A shortlist answers "what could apply to
/// this request", so it stays far below the full catalog.
pub const SHORTLIST_BUDGET_CHARS: usize = 6_000;

/// Name + description of every skill, used to rank a shortlist. Returned as
/// lowercase text so callers match without re-allocating per candidate.
pub fn match_text(skill: &Skill) -> String {
    format!(
        "{} {}",
        skill.meta.name.replace('-', " "),
        skill.meta.description
    )
    .to_lowercase()
}

/// Words worth matching against a skill name or description.
///
/// Latin words shorter than three characters and CJK terms shorter than two
/// characters carry no signal ("the", "a", "的"). Stripping them keeps the
/// shortlist from matching every skill.
pub fn query_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut current = String::new();
    for character in query.chars() {
        let is_word = character.is_alphanumeric() || character == '-';
        if is_word {
            current.push(character);
            continue;
        }
        push_term(&mut terms, &mut current);
    }
    push_term(&mut terms, &mut current);
    terms.sort();
    terms.dedup();
    terms
}

/// Function words carry no topical signal. Without this list a request like
/// "how do I read a serial port" matches every skill whose description
/// contains "a" or "the".
const STOP_WORDS: &[&str] = &[
    "the", "and", "for", "with", "how", "what", "why", "when", "where", "which", "who", "this",
    "that", "these", "those", "from", "into", "onto", "over", "under", "about", "after", "before",
    "can", "could", "should", "would", "will", "shall", "may", "might", "must", "does", "did",
    "doing", "done", "have", "has", "had", "you", "your", "yours", "our", "ours", "they", "them",
    "their", "there", "here", "are", "was", "were", "been", "being", "not", "but", "also", "just",
    "only", "very", "more", "most", "some", "any", "all", "each", "every", "both", "either",
    "neither", "such", "than", "then", "too", "using", "use", "used", "make", "made", "get", "got",
    "need", "want", "like", "please", "help", "tell", "give", "show",
];

fn push_term(terms: &mut Vec<String>, current: &mut String) {
    let term = current.trim_matches('-').to_lowercase();
    current.clear();
    if term.is_empty() {
        return;
    }
    // A CJK sentence arrives as one token because it has no spaces. Emit
    // character bigrams for each CJK run so a skill description mentioning
    // 串口 still matches 仓库里有串口代码吗.
    let mut latin = String::new();
    let mut cjk = String::new();
    for character in term.chars() {
        if character.is_ascii() {
            if !cjk.is_empty() {
                push_cjk_bigrams(terms, &mut cjk);
            }
            latin.push(character);
        } else {
            if !latin.is_empty() {
                push_latin_term(terms, &mut latin);
            }
            cjk.push(character);
        }
    }
    push_cjk_bigrams(terms, &mut cjk);
    push_latin_term(terms, &mut latin);
}

fn push_latin_term(terms: &mut Vec<String>, buffer: &mut String) {
    let term = buffer.trim_matches('-').to_lowercase();
    buffer.clear();
    if term.chars().count() >= 3 && !STOP_WORDS.contains(&term.as_str()) {
        terms.push(term);
    }
}

fn push_cjk_bigrams(terms: &mut Vec<String>, buffer: &mut String) {
    let run = std::mem::take(buffer);
    let characters: Vec<char> = run.chars().filter(|c| !is_cjk_punctuation(*c)).collect();
    if characters.len() == 1 {
        return;
    }
    for pair in characters.windows(2) {
        let term: String = pair.iter().collect();
        terms.push(term);
    }
}

fn is_cjk_punctuation(character: char) -> bool {
    matches!(
        character,
        '的' | '了' | '吗' | '呢' | '吧' | '啊' | '是' | '在' | '有' | '和' | '与'
    )
}

/// Keep only the skills whose name or description mentions one of `terms`.
///
/// With six-figure skill catalogs the full block is mostly irrelevant noise;
/// ranking by the words the user actually typed keeps the prompt small while
/// still advertising every skill that could plausibly apply.
pub fn shortlist_skills(skills: &[Skill], terms: &[String], limit: usize) -> Vec<Skill> {
    let enabled: Vec<Skill> = skills.iter().filter(|s| s.enabled).cloned().collect();
    if terms.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut scored: Vec<(usize, Skill)> = Vec::new();
    for skill in enabled {
        let text = match_text(&skill);
        let score = terms
            .iter()
            .filter(|term| term_matches(&text, term))
            .count();
        if score > 0 {
            scored.push((score, skill));
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.meta.name.cmp(&b.1.meta.name))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(_, skill)| skill)
        .collect()
}

/// CJK has no spaces, so a substring is the intended match. Latin text needs a
/// word boundary: `port` must not match `reports`.
fn term_matches(haystack: &str, term: &str) -> bool {
    if term.is_empty() {
        return false;
    }
    if term.chars().any(|c| !c.is_ascii()) {
        return haystack.contains(term);
    }
    let mut searched = 0;
    while let Some(offset) = haystack[searched..].find(term) {
        let start = searched + offset;
        let end = start + term.len();
        let before_ok = haystack[..start]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let after_ok = haystack[end..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        searched = end;
    }
    false
}

/// Prompt block for a ranked shortlist, plus the total of enabled skills so the
/// model knows the list is a selection rather than the whole catalog.
pub fn shortlist_block(shortlist: &[Skill], enabled_total: usize) -> String {
    if shortlist.is_empty() {
        return String::new();
    }
    let mut block = available_skills_block_with_budget(shortlist, SHORTLIST_BUDGET_CHARS);
    // Insert the count line right after the opening tag so the truncation
    // tiers stay untouched.
    if let Some(end) = block.find('\n') {
        block.insert_str(
            end,
            &format!(
                "\n{shortlist}/{enabled} skills match this request; call `skill_read` with an exact \
                 name. Use `skill_search` to find other skills.",
                shortlist = shortlist.len(),
                enabled = enabled_total
            )
            .replace('\n', " "),
        );
    }
    block
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

    fn query(text: &str) -> Vec<String> {
        query_terms(text)
    }

    #[test]
    fn query_terms_drop_stop_words_and_keep_cjk() {
        // "where", "is" and "the" carry no topic signal; 串口 does.
        assert_eq!(query("where is the serial port"), ["port", "serial"]);
        assert!(query("仓库里有串口代码吗").contains(&"串口".to_string()));
        assert!(!query("的了吗").iter().any(|term| term == "的"));
        assert!(query("").is_empty());
    }

    #[test]
    fn latin_terms_need_a_word_boundary() {
        // "port" must not match "reports"; "serial" must match "serial-port".
        let skills = vec![
            skill("excel-report", "build spreadsheet reports", true),
            skill("serial-port", "read hardware serial ports", true),
        ];
        let picked = shortlist_skills(&skills, &query("read a serial port"), 10);
        assert_eq!(
            picked
                .iter()
                .map(|s| s.meta.name.as_str())
                .collect::<Vec<_>>(),
            ["serial-port"]
        );
    }

    #[test]
    fn shortlist_ranks_matches_and_reports_the_total() {
        let skills = vec![
            skill("serial-port", "read and write hardware serial ports", true),
            skill("pdf-workflow", "fill and sign PDF forms", true),
            skill("excel-report", "build spreadsheet reports", true),
        ];
        let picked = shortlist_skills(&skills, &query("how do I read a serial port"), 10);
        assert_eq!(
            picked
                .iter()
                .map(|s| s.meta.name.as_str())
                .collect::<Vec<_>>(),
            ["serial-port"]
        );
        let block = shortlist_block(&picked, skills.len());
        assert!(block.starts_with("<available_skills>"));
        assert!(block.contains("1/3 skills match this request"));
        assert!(block.contains("serial-port:"));
        assert!(!block.contains("pdf-workflow"));
    }

    #[test]
    fn shortlist_is_capped_and_disabled_skills_are_ignored() {
        let skills: Vec<Skill> = (0..40)
            .map(|i| skill(&format!("serial-{i}"), "serial helper", true))
            .collect();
        let mut skills = skills;
        skills.push(skill("serial-off", "serial helper", false));
        let picked = shortlist_skills(&skills, &query("serial"), 5);
        assert_eq!(picked.len(), 5);
        assert!(picked.iter().all(|s| s.meta.name != "serial-off"));
        // No terms means no shortlist: the caller falls back to the full block.
        assert!(shortlist_skills(&skills, &[], 5).is_empty());
    }
}
